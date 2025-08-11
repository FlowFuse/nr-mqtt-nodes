/**
 * Parses an nr-mqtt Node userId or clientId auth string into its components.
 * @param {String} id - the ID to parse, expected format: `mq:hosted:teamId:instanceId[:haId]` or `mq:remote:teamId:deviceId[:projectId]`
 * @param {'username'|'clientId'} [kind='username'] - the kind of ID to parse `'username'` or `'clientId'`
 * @returns Parsed ID object
 */
function parseNrMqttId (id, kind = 'username') {
    const validLengths = kind === 'clientId' ? [4, 5] : [4]
    const result = {
        teamId: null,
        parentId: null,
        parentType: null,
        ownerId: null,
        ownerType: null,
        haId: null,
        teamClientUsername: null
    }
    const parts = id.split(':')
    if (!validLengths.includes(parts.length)) {
        throw new Error(`Invalid ID format: ${id}`)
    }

    const [mq, instanceType, teamId, instanceId, part5] = parts
    if (mq !== 'mq') {
        throw new Error(`Invalid ID format: ${id}`)
    }
    result.teamId = teamId
    result.ownerId = instanceId
    if (instanceType === 'hosted') {
        result.ownerType = 'instance'
        result.parentType = 'application' // instances are treated as application owned
        result.parentId = null // no application ID available at this point (or necessary)
        result.teamClientUsername = `instance:${instanceId}`
        if (kind === 'clientId' && parts.length === 4) {
            // since a clientId can have a haId, we need to compute the teamClientUsername accordingly
            result.haId = part5 || null
        }
    } else if (instanceType === 'remote') {
        result.ownerType = 'device'
        result.teamClientUsername = `device:${instanceId}`
        result.parentType = 'application'
        if (parts.length === 5) {
            result.parentId = part5 // projectId
            result.parentType = 'project'
        } else {
            result.parentId = null // no projectId for app owned devices
        }
    } else {
        throw new Error('Invalid ID format')
    }
    return result
}

/**
 * Creates an MQTT Auth ID for a team instance nr-mqtt client.
 * Auth ID is used to identify the broker client by type, team, id and optionally haId.
 *  - `mq:hosted:instanceId` for hosted instances
 *  - `mq:hosted:instanceId:haId` for hosted High Availability instances
 *  - `mq:remote:deviceId:projectId` for Instance Owned devices
 *  - `mq:remote:deviceId` for Application Owned devices
 * @param {string} teamId - team hash ID
 * @param {'device'|'project'|'instance'} instanceType - the type of instance
 * @param {string} instanceId - the ID of the instance or device
 * @returns {string} - The created MQTT Auth ID e.g. `mq:hosted:instanceId`
 */
function createNrMqttId (teamId, instanceType, instanceId) {
    let _type = instanceType
    if (instanceType === 'remote' || instanceType === 'device') {
        _type = 'remote' // remote devices
    } else if (instanceType === 'hosted' || instanceType === 'instance' || instanceType === 'project') {
        _type = 'hosted' // hosted instances
    }

    const parts = ['mq', _type, teamId, instanceId]
    return parts.join(':')
}

/**
 * Creates an MQTT Client ID for a team instance nr-mqtt client.
 * Client ID is used to identify the broker client by type, team, id and optionally haId.
 * @param {string} teamId - team hash ID
 * @param {'device'|'instance'|'project'} instanceType - the type of instance (e.g., 'hosted', 'device')
 * @param {string} instanceId - the ID of the instance or device
 * @param {string} [haId=null] - optional High Availability instance ID
 * @returns {string} - The created MQTT Client ID e.g. `mq:hosted:instanceId:haId`
 */
function createNrMqttClientId (teamId, instanceType, instanceId, haId = null) {
    let mqttId = createNrMqttId(teamId, instanceType, instanceId)
    if (haId && mqttId.startsWith('mq:hosted:')) {
        mqttId += `:${haId}` // add haId for hosted instances
    }
    return mqttId
}

/**
 * Helper function to test an object has a property
 * @param {object} obj Object to test
 * @param {string} propName Name of property to find
 * @returns true if object has property `propName`
 */
function hasProperty (obj, propName) {
    // JavaScript does not protect the property name hasOwnProperty
    // Object.prototype.hasOwnProperty.call is the recommended/safer test
    return Object.prototype.hasOwnProperty.call(obj, propName)
}

module.exports = {
    parseNrMqttId,
    createNrMqttId,
    createNrMqttClientId,
    hasProperty
}
