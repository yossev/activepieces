import { URL } from 'url'
import { Action, ActionContext, ConnectionsManager, PauseHook, PauseHookParams, PiecePropertyMap, RunFunctionReturnType, StaticPropsValue, StopHook, StopHookParams, TagsManager } from '@activepieces/pieces-framework'
import { ActionType, assertNotNullOrUndefined, AUTHENTICATION_PROPERTY_NAME, ExecutionType, FlowRunStatus, GenericStepOutput, isNil, PauseType, PieceAction, StepOutputStatus } from '@activepieces/shared'
import { continueIfFailureHandler, handleExecutionError, runWithExponentialBackoff } from '../helper/error-handling'
import { pieceLoader } from '../helper/piece-loader'
import { createConnectionService } from '../services/connections.service'
import { createFilesService } from '../services/files.service'
import { createContextStore } from '../services/storage.service'
import { ActionHandler, BaseExecutor } from './base-executor'
import { EngineConstants } from './context/engine-constants'
import { ExecutionVerdict, FlowExecutorContext } from './context/flow-execution-context'
import { flowExecutor } from './flow-executor'

type HookResponse = { stopResponse: StopHookParams | undefined, pauseResponse: PauseHookParams | undefined, tags: string[], stopped: boolean, paused: boolean }

type RunBranchablePieceWithVersion = {
    version: 'v1'
    pieceOutput: RunFunctionReturnType
    executionState: FlowExecutorContext
    action: PieceAction
    constants: EngineConstants
    stepOutput: GenericStepOutput<ActionType.PIECE, unknown>
}

export const pieceExecutor: BaseExecutor<PieceAction> = {
    async handle({
        action,
        executionState,
        constants,
    }: {
        action: PieceAction
        executionState: FlowExecutorContext
        constants: EngineConstants
    }) {
        if (executionState.isCompleted({ stepName: action.name })) {
            return executionState
        }
        const resultExecution = await runWithExponentialBackoff(executionState, action, constants, executeAction)
        return continueIfFailureHandler(resultExecution, action, constants)
    },
}

const executeAction: ActionHandler<PieceAction> = async ({ action, executionState, constants }) => {
    const stepOutput = GenericStepOutput.create({
        input: {},
        type: ActionType.PIECE,
        status: StepOutputStatus.SUCCEEDED,
    })

    try {
        assertNotNullOrUndefined(action.settings.actionName, 'actionName')
        const { pieceAction, piece } = await pieceLoader.getPieceAndActionOrThrow({
            pieceName: action.settings.pieceName,
            pieceVersion: action.settings.pieceVersion,
            actionName: action.settings.actionName,
            piecesSource: constants.piecesSource,
        })

        const { resolvedInput, censoredInput } = await constants.variableService.resolve<StaticPropsValue<PiecePropertyMap>>({
            unresolvedInput: action.settings.input,
            executionState,
        })

        stepOutput.input = censoredInput

        const { processedInput, errors } = await constants.variableService.applyProcessorsAndValidators(resolvedInput, pieceAction.props, piece.auth)
        if (Object.keys(errors).length > 0) {
            throw new Error(JSON.stringify(errors))
        }

        const hookResponse: HookResponse = {
            stopResponse: undefined,
            stopped: false,
            pauseResponse: undefined,
            paused: false,
            tags: [],
        }
        const isPaused = executionState.isPaused({ stepName: action.name })
        const context: ActionContext = {
            executionType: isPaused ? ExecutionType.RESUME : ExecutionType.BEGIN,
            resumePayload: constants.resumePayload!,
            store: createContextStore({
                prefix: '',
                flowId: constants.flowId,
                workerToken: constants.workerToken,
            }),
            auth: processedInput[AUTHENTICATION_PROPERTY_NAME],
            files: createFilesService({
                workerToken: constants.workerToken,
                stepName: action.name,
                flowId: constants.flowId,
                type: constants.filesServiceType,
            }),
            server: {
                token: constants.workerToken,
                apiUrl: constants.apiUrl,
                publicUrl: constants.serverUrl,
            },
            propsValue: processedInput,
            tags: createTagsManager(hookResponse),
            connections: createConnectionManager({
                projectId: constants.projectId,
                workerToken: constants.workerToken,
                hookResponse,
            }),
            serverUrl: constants.serverUrl,
            run: {
                id: constants.flowRunId,
                stop: createStopHook(hookResponse),
                pause: createPauseHook(hookResponse, executionState.pauseRequestId),
            },
            project: {
                id: constants.projectId,
                externalId: constants.externalProjectId,
            },
            generateResumeUrl: (params) => {
                const url = new URL(`${constants.serverUrl}v1/flow-runs/${constants.flowRunId}/requests/${executionState.pauseRequestId}`)
                url.search = new URLSearchParams(params.queryParams).toString()
                return url.toString()
            },
        }
        const runMethodToExecute = (constants.testSingleStepMode && !isNil(pieceAction.test)) ? pieceAction.test : pieceAction.run
        const output = await runMethodToExecute(context)
        const newExecutionContext = executionState.addTags(hookResponse.tags)

        if (hookResponse.stopped) {
            assertNotNullOrUndefined(hookResponse.stopResponse, 'stopResponse')
            return newExecutionContext.upsertStep(action.name, stepOutput.setOutput(output)).setVerdict(ExecutionVerdict.SUCCEEDED, {
                reason: FlowRunStatus.STOPPED,
                stopResponse: hookResponse.stopResponse.response,
            }).increaseTask()
        }
        if (hookResponse.paused) {
            assertNotNullOrUndefined(hookResponse.pauseResponse, 'pauseResponse')
            return newExecutionContext.upsertStep(action.name, stepOutput.setOutput(output).setStatus(StepOutputStatus.PAUSED))
                .setVerdict(ExecutionVerdict.PAUSED, {
                    reason: FlowRunStatus.PAUSED,
                    pauseMetadata: hookResponse.pauseResponse.pauseMetadata,
                })
        }
        if (action.children && hasBranches(pieceAction)) {
            const pieceOutput = output as RunFunctionReturnType

            return await runBranchablePieceWithVersion({
                executionState,
                pieceOutput,
                action,
                constants,
                stepOutput,
                version: pieceOutput.version,
            })
        }

        return newExecutionContext.upsertStep(action.name, stepOutput.setOutput(output)).increaseTask().setVerdict(ExecutionVerdict.RUNNING, undefined)
    }
    catch (e) {
        const handledError = handleExecutionError(e)

        const failedStepOutput = stepOutput
            .setStatus(StepOutputStatus.FAILED)
            .setErrorMessage(handledError.message)

        return executionState
            .upsertStep(action.name, failedStepOutput)
            .setVerdict(ExecutionVerdict.FAILED, handledError.verdictResponse)
    }
}

function hasBranches(pieceAction: Action): boolean {
    return !isNil(pieceAction.outputs) && pieceAction.outputs.length > 1
}

async function runBranchablePieceWithVersion({ 
    pieceOutput,
    executionState, 
    action, 
    constants,
    stepOutput, 
    version = 'v1', 
}: RunBranchablePieceWithVersion): Promise<FlowExecutorContext> {
    const versions = {
        v1: async (): Promise<FlowExecutorContext> => {
            let newExecutionContext = executionState
            let outputValue = undefined
            for (const [k, v] of pieceOutput.output.entries()) {
                if (v === false || v === undefined || isNil(v)) {
                    continue
                }
    
                if (isNil(action.children)) {
                    continue
                }

                newExecutionContext = await flowExecutor.execute({
                    action: action.children.filter(child => child.name === k)[0].action,
                    executionState: newExecutionContext,
                    constants,
                })
                outputValue = v
            }
            return newExecutionContext.upsertStep(action.name, stepOutput.setOutput(outputValue)).increaseTask().setVerdict(ExecutionVerdict.RUNNING, undefined)
        },
    }

    return versions[version]()
}

const createTagsManager = (hookResponse: HookResponse): TagsManager => {
    return {
        add: async (params: {
            name: string
        }): Promise<void> => {
            hookResponse.tags.push(params.name)
        },

    }
}

const createConnectionManager = ({ workerToken, projectId, hookResponse }: { projectId: string, workerToken: string, hookResponse: HookResponse }): ConnectionsManager => {
    return {
        get: async (key: string) => {
            try {
                const connection = await createConnectionService({ projectId, workerToken }).obtain(key)
                hookResponse.tags.push(`connection:${key}`)
                return connection
            }
            catch (e) {
                return null
            }
        },
    }
}

function createStopHook(hookResponse: HookResponse): StopHook {
    return (req: StopHookParams) => {
        hookResponse.stopped = true
        hookResponse.stopResponse = req
    }
}

function createPauseHook(hookResponse: HookResponse, pauseId: string): PauseHook {
    return (req) => {
        hookResponse.paused = true
        switch (req.pauseMetadata.type) {
            case PauseType.DELAY:
                hookResponse.pauseResponse = {
                    pauseMetadata: req.pauseMetadata,
                }
                break
            case PauseType.WEBHOOK:
                hookResponse.pauseResponse = {
                    pauseMetadata: {
                        ...req.pauseMetadata,
                        requestId: pauseId,
                    },
                }
                break
        }
    }
}
