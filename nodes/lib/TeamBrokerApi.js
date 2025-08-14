/**
 * @typedef {Object} LinkResult
 * @property {string} id - The ID of the broker client
 * @property {string} username - The username for the broker client
 * @property {Array} acls - The access control lists for the broker client
 * @property {Object} owner - The owner of the broker client
 * @property {string} owner.instanceType - The type of instance (e.g., 'hosted')
 * @property {string} owner.id - The ID of the owner instance
 * @property {string} owner.name - The name of the owner instance
 * @property {string} password - The password for the broker client
 */

/**
 * Creates an API for interacting with the FlowFuse platform
 * @param {Object} RED - The Node-RED runtime object
 * @param {import('got').Got} gotClient - The got client to use for making HTTP requests
 * @param {Object} options - Configuration parameters
 * @param {string} options.forgeURL - The Forge URL
 * @param {string} options.teamId - The team ID
 * @param {string} options.token - The authentication token
 * @param {string} [options.API_VERSION='v1'] - The API version to use
 * @example
 * const { TeamBrokerApi } = require('./lib/TeamBrokerApi.js');
 * const got = require('got').default;
 * const forgeURL = 'https://example.com/forge';
 * const teamBrokerApi = TeamBrokerApi(RED, got, { forgeURL, teamId: "abcdef", token: "your-token" });
 */
function TeamBrokerApi (gotClient, { forgeURL, teamId, instanceType, instanceId, token, API_VERSION = 'v1', API_TIMEOUT = 5000 } = {}) {
    const teamClientUserId = `${instanceType}:${instanceId}`
    const baseURL = `${forgeURL}/api/${API_VERSION}/teams/${teamId}/broker/client`
    const got = gotClient.extend({
        headers: {
            Authorization: `Bearer ${token}`
        },
        timeout: {
            request: API_TIMEOUT
        }
    })

    /**
     * Get the broker client user information
     * @returns {Promise<Object>} - The broker client information
     */
    async function getClient () {
        const url = `${baseURL}/${teamClientUserId}`
        const res = await got.get(url)
        if (res.statusCode !== 200) {
            throw new Error(`Failed to fetch client: ${res.statusCode} ${res.statusMessage}`)
        }
        const data = JSON.parse(res.body)
        return data
    }

    /**
     * Link this instance to a broker client
     * @param {string} password - The password to use for linking
     * @returns {Promise<LinkResult>} - Returns broker settings
     * @throws {Error} - Throws an error if the request fails
     */
    async function link (password) {
        const url = `${baseURL}/${teamClientUserId}/link`
        console.debug(`Linking instance to broker client via URL: ${url}`)
        const res = await got.post(url, {
            json: {
                password
            }
        })
        if (res.statusCode !== 200 && res.statusCode !== 201) {
            throw new Error(`Failed to link instances: ${res.statusCode} ${res.statusMessage}`)
        }
        const data = JSON.parse(res.body)
        return data
    }

    return {
        getClient,
        link
    }
}

module.exports = {
    TeamBrokerApi
}
