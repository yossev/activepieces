import { AppSystemProp, system } from '@activepieces/server-shared'
import { isNil } from '@activepieces/shared'
import Redis, { RedisOptions } from 'ioredis'

const url = system.get(AppSystemProp.REDIS_URL)
const username = system.get(AppSystemProp.REDIS_USER)
const password = system.get(AppSystemProp.REDIS_PASSWORD)
const useSsl = system.getBoolean(AppSystemProp.REDIS_USE_SSL) ?? false
const db = system.getNumber(AppSystemProp.REDIS_DB) ?? 0
const sentinelList = system.get(AppSystemProp.REDIS_SENTINELS)

export const createRedisClient = (params?: CreateRedisClientParams): Redis => {
    const config: Partial<RedisOptions> = {
        maxRetriesPerRequest: null,
        ...params,
    }

    if (sentinelList) {
        const sentinels = sentinelList.split(',').map((sentinel) => {
            const [host, port] = sentinel.split(':')
            return { host, port: Number.parseInt(port, 10) }
        })
        const name = sentinels[0].host
        return new Redis({
            ...config,
            sentinels,
            name,
            enableTLSForSentinelMode: useSsl ? true : undefined,
        })
    }

    if (url) {
        return new Redis(url, {
            ...config,
        })
    }

    const host = system.getOrThrow(AppSystemProp.REDIS_HOST)
    const serializedPort = system.getOrThrow(AppSystemProp.REDIS_PORT)
    const port = Number.parseInt(serializedPort, 10)

    return new Redis({
        ...config,
        host,
        port,
        username,
        password,
        db,
        tls: useSsl ? {} : undefined,
    })
}

type CreateRedisClientParams = {
    /**
   * connection timeout in milliseconds
   */
    connectTimeout?: number
    maxRetriesPerRequest?: number
}

export const getRedisConnection = (() => {
    let redis: Redis | null = null

    return (): Redis => {
        if (!isNil(redis)) {
            return redis
        }
        redis = createRedisClient()
        return redis
    }
})()
