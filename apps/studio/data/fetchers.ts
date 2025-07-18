import * as Sentry from '@sentry/nextjs'
import createClient from 'openapi-fetch'

import { IS_PLATFORM } from 'common'
import { API_URL } from 'lib/constants'
import { getAccessToken } from 'lib/gotrue'
import { uuidv4 } from 'lib/helpers'
import { ResponseError } from 'types'
import type { paths } from './api' // generated from openapi-typescript

const DEFAULT_HEADERS = { Accept: 'application/json' }

export const fetchHandler: typeof fetch = async (input, init) => {
  try {
    return await fetch(input, init)
  } catch (err: any) {
    if (err instanceof TypeError && err.message === 'Failed to fetch') {
      throw new Error('Unable to reach the server. Please check your network or try again later.')
    }
    throw err
  }
}

const client = createClient<paths>({
  fetch: fetchHandler,
  // [Joshen] Just FYI, the replace is temporary until we update env vars API_URL to remove /platform or /v1 - should just be the base URL
  baseUrl: API_URL?.replace('/platform', ''),
  referrerPolicy: 'no-referrer-when-downgrade',
  headers: DEFAULT_HEADERS,
  credentials: 'include',
  querySerializer: {
    array: {
      style: 'form',
      explode: false,
    },
  },
})

export function isValidConnString(connString?: string | null) {
  // If there is no `connectionString` on platform, pg-meta will necessarily fail to connect to the target database.
  // This only applies if IS_PLATFORM is true; otherwise (test/local-dev), pg-meta won't need this parameter
  // and will connect to the locally running DB_URL instead.
  return IS_PLATFORM ? Boolean(connString) : true
}

export async function constructHeaders(headersInit?: HeadersInit | undefined) {
  const requestId = uuidv4()
  const headers = new Headers(headersInit)

  headers.set('X-Request-Id', requestId)

  if (!headers.has('Authorization')) {
    const accessToken = await getAccessToken()
    if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)
  }

  return headers
}

function pgMetaGuard(request: Request) {
  // Only check for /platform/pg-meta/ endpoints
  if (request.url.includes('/platform/pg-meta/')) {
    // If there is no valid `x-connection-encrypted`, pg-meta will necesseraly fail to connect to the target database
    // in such case, we save the hops and throw a 421 response instead
    if (!isValidConnString(request.headers.get('x-connection-encrypted'))) {
      const retryAfterHeader = request.headers.get('Retry-After')
      throw new ResponseError(
        'API Error: happened while trying to acquire connection to the database',
        400,
        request.headers.get('X-Request-Id') ?? undefined,
        retryAfterHeader ? parseInt(retryAfterHeader) : undefined
      )
    }
  }
  return request
}

// Middleware
client.use(
  {
    // Middleware to add authorization headers to the request
    async onRequest({ request }) {
      const headers = await constructHeaders()
      headers.forEach((value, key) => request.headers.set(key, value))
      return pgMetaGuard(request)
    },
  },
  {
    // Middleware to format errors
    async onResponse({ request, response }) {
      if (response.ok) {
        return response
      }

      // handle errors
      try {
        // attempt to parse the response body as JSON
        let body = await response.clone().json()

        // add code field to body
        body.code = response.status
        body.requestId = request.headers.get('X-Request-Id')
        const retryAfterHeader = response.headers.get('Retry-After')
        body.retryAfter = retryAfterHeader ? parseInt(retryAfterHeader) : undefined

        return new Response(JSON.stringify(body), {
          headers: response.headers,
          status: response.status,
          statusText: response.statusText,
        })
      } catch {
        // noop
      }

      return response
    },
  }
)

export const {
  GET: get,
  POST: post,
  PUT: put,
  PATCH: patch,
  DELETE: del,
  HEAD: head,
  TRACE: trace,
  OPTIONS: options,
} = client

type HandleErrorOptions = {
  alwaysCapture?: boolean
}

export const handleError = (
  error: unknown,
  options: HandleErrorOptions = { alwaysCapture: false }
): never => {
  if (error && typeof error === 'object') {
    if (options.alwaysCapture) {
      Sentry.captureException(error)
    }
    const errorMessage =
      'msg' in error && typeof error.msg === 'string'
        ? error.msg
        : 'message' in error && typeof error.message === 'string'
          ? error.message
          : undefined

    const errorCode = 'code' in error && typeof error.code === 'number' ? error.code : undefined
    const requestId =
      'requestId' in error && typeof error.requestId === 'string' ? error.requestId : undefined
    const retryAfter =
      'retryAfter' in error && typeof error.retryAfter === 'number' ? error.retryAfter : undefined

    if (errorMessage) {
      throw new ResponseError(errorMessage, errorCode, requestId, retryAfter)
    }
  }

  if (error !== null && typeof error === 'object' && 'stack' in error) {
    console.error(error.stack)
  }

  // the error doesn't have a message or msg property, so we can't throw it as an error. Log it via Sentry so that we can
  // add handling for it.
  Sentry.captureException(error)

  // throw a generic error if we don't know what the error is. The message is intentionally vague because it might show
  // up in the UI.
  throw new ResponseError(undefined)
}

// [Joshen] The methods below are brought over from lib/common/fetchers because we still need them
// primarily for our own endpoints in the dashboard repo. So consolidating all the fetch methods into here.

async function handleFetchResponse<T>(response: Response): Promise<T | ResponseError> {
  const contentType = response.headers.get('Content-Type')
  if (contentType === 'application/octet-stream') return response as any
  try {
    const resTxt = await response.text()
    try {
      // try to parse response text as json
      return JSON.parse(resTxt)
    } catch (err) {
      // return as text plain
      return resTxt as any
    }
  } catch (e) {
    return handleError(response) as T | ResponseError
  }
}

/**
 * To be used only for dashboard API endpoints. Use `fetch` directly if calling a non dashboard API endpoint
 *
 * Exception for `bucket-object-download-mutation` as openapi-fetch doesn't support octet-stream responses
 */
export async function fetchPost<T = any>(
  url: string,
  data: { [prop: string]: any },
  options?: { [prop: string]: any }
): Promise<T | ResponseError> {
  try {
    const { headers: otherHeaders, abortSignal, ...otherOptions } = options ?? {}
    const headers = await constructHeaders({
      'Content-Type': 'application/json',
      ...DEFAULT_HEADERS,
      ...otherHeaders,
    })
    const response = await fetch(url, {
      method: 'POST',
      body: JSON.stringify(data),
      referrerPolicy: 'no-referrer-when-downgrade',
      headers,
      ...otherOptions,
      signal: abortSignal,
    })
    if (!response.ok) return handleError(response)
    return handleFetchResponse(response)
  } catch (error) {
    return handleError(error)
  }
}
