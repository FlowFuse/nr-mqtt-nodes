/*
This is a fork of the MQTT nodes from Node-RED.
The original code can be found at:
https://github.com/node-red/node-red/blob/abceb1185bc81e869c11918bed3fb17e0bc83dd5/packages/node_modules/@node-red/nodes/core/network/10-mqtt.js
Below is the copyright notice for the original code.
The copyright notice for this fork is the same as the original.
### Changes:
- Hide advanced features
- Remove the config node for MQTT broker
- Remove the dynamic connection control
- lint errors fixed up
*/
/* eslint-disable brace-style */
const ProxyHelper = require('./lib/proxyHelper.js')
const { createNrMqttId, createNrMqttClientId } = require('./lib/util.js')
const TeamBrokerApi = require('./lib/TeamBrokerApi.js')
const os = require('os')
const Got = require('got').default

module.exports = function (RED) {
    'use strict'

    const forgeSettings = RED.settings.flowforge || {}
    if (!forgeSettings.teamID) {
        throw new Error('FlowFuse MQTT nodes cannot be loaded outside of an FlowFuse EE environment')
    }
    const mqttSettings = forgeSettings.mqttNodes || forgeSettings.projectLink
    if (!mqttSettings || !mqttSettings.broker) {
        throw new Error('FlowFuse MQTT nodes cannot be loaded without a broker configured in FlowFuse EE settings')
    }

    const teamId = forgeSettings.teamID
    const deviceId = forgeSettings.deviceID || ''
    const projectId = forgeSettings.instanceID || forgeSettings.projectID || ''
    const HA_INSTANCE = forgeSettings.projectLink?.useSharedSubscriptions
    // It is not unreasonable to expect `projectID` and `applicationID` are set for an instance
    // owned device, however an application owned device should not have a projectID.
    // therefore, assume project owned if `projectID` is set
    // eslint-disable-next-line no-unused-vars
    const DEVICE_OWNER_TYPE = forgeSettings.projectID ? 'instance' : 'application'

    // Generate a unique ID based on the hostname
    // This is then used when in HA/sharedSubscription mode to ensure the instance has
    // a unique clientId that is stable across restarts
    const haInstanceId = HA_INSTANCE ? crypto.createHash('md5').update(os.hostname()).digest('hex').substring(0, 4) : null

    let instanceType = ''
    let instanceId = ''
    if (deviceId) {
        instanceType = 'device'
        instanceId = deviceId
    } else if (projectId) {
        instanceType = 'instance'
        instanceId = projectId
    } else {
        // throw error?
        throw new Error('FlowFuse MQTT nodes cannot be loaded due to missing instance information')
    }

    const TEAM_CLIENT_AUTH_ID = createNrMqttId(forgeSettings.teamID, instanceType, instanceId) // e.g., 'mq:remote:teamId:deviceId' or 'mq:hosted:teamId:projectId:haId'
    const TEAM_CLIENT_CLIENT_ID = createNrMqttClientId(forgeSettings.teamID, instanceType, instanceId, haInstanceId) // e.g., 'mq:remote:deviceId' or 'mq:hosted:projectId:haId'
    const ALLOW_DYNAMIC_CONNECT_OPTIONS = false // disable dynamic connect options for this type of node (fixed broker connection)
    const got = Got.extend({
        agent: ProxyHelper.getHTTPProxyAgent(forgeSettings.forgeURL, { timeout: 4000 })
    })

    /** @type {MQTTBrokerNode} */
    const sharedBroker = new MQTTBrokerNode()

    /* Monitor link status and attept to relink if node has users but is unlinked */
    let linkTryCount = 0
    const MAX_LINK_ATTEMPTS = 5
    sharedBroker.linkMonitorInterval = setInterval(async function () {
        if (Object.keys(sharedBroker.users).length < 1) {
            return // no users, no need to link
        }

        if (sharedBroker.linked && !sharedBroker.linkFailed) {
            return
        }
        if (sharedBroker.linkFailed) {
            try {
                linkTryCount++
                await sharedBroker.link()
                linkTryCount = 0
            } catch (_err) {
                if (linkTryCount >= MAX_LINK_ATTEMPTS) {
                    clearInterval(sharedBroker.linkMonitorInterval)
                    sharedBroker.linkMonitorInterval = null
                    sharedBroker.warn('Maximum Failed Link Attempts. Restart or redeploy to re-establish the connection.')
                }
            }
        }
    }, (Math.floor(Math.random() * 10000) + 55000)) // 55-65 seconds

    const mqtt = require('mqtt')
    const isUtf8 = require('is-utf8')

    const knownMediaTypes = {
        'text/css': 'string',
        'text/html': 'string',
        'text/plain': 'string',
        'application/json': 'json',
        'application/octet-stream': 'buffer',
        'application/pdf': 'buffer',
        'application/x-gtar': 'buffer',
        'application/x-gzip': 'buffer',
        'application/x-tar': 'buffer',
        'application/xml': 'string',
        'application/zip': 'buffer',
        'audio/aac': 'buffer',
        'audio/ac3': 'buffer',
        'audio/basic': 'buffer',
        'audio/mp4': 'buffer',
        'audio/ogg': 'buffer',
        'image/bmp': 'buffer',
        'image/gif': 'buffer',
        'image/jpeg': 'buffer',
        'image/tiff': 'buffer',
        'image/png': 'buffer'
    }
    // #region "Supporting functions"
    function matchTopic (ts, t) {
        if (ts === '#') {
            return true
        } else if (ts.startsWith('$share')) {
            /* The following allows shared subscriptions (as in MQTT v5)
                http://docs.oasis-open.org/mqtt/mqtt/v5.0/cs02/mqtt-v5.0-cs02.html#_Toc514345522

                4.8.2 describes shares like:
                $share/{ShareName}/{filter}
                $share is a literal string that marks the Topic Filter as being a Shared Subscription Topic Filter.
                {ShareName} is a character string that does not include "/", "+" or "#"
                {filter} The remainder of the string has the same syntax and semantics as a Topic Filter in a non-shared subscription. Refer to section 4.7.
            */
            ts = ts.replace(/^\$share\/[^#+/]+\/(.*)/g, '$1')
        }
        // eslint-disable-next-line no-useless-escape
        const re = new RegExp('^' + ts.replace(/([\[\]\?\(\)\\\\$\^\*\.|])/g, '\\$1').replace(/\+/g, '[^/]+').replace(/\/#$/, '(\/.*)?') + '$')
        return re.test(t)
    }

    /**
     * Helper function for setting integer property values in the MQTT V5 properties object
     * @param {object} src Source object containing properties
     * @param {object} dst Destination object to set/add properties
     * @param {string} propName The property name to set in the Destination object
     * @param {integer} [minVal] The minimum value. If the src value is less than minVal, it will NOT be set in the destination
     * @param {integer} [maxVal] The maximum value. If the src value is greater than maxVal, it will NOT be set in the destination
     * @param {integer} [def] An optional default to set in the destination object if prop is NOT present in the soruce object
     */
    function setIntProp (src, dst, propName, minVal, maxVal, def) {
        if (hasProperty(src, propName)) {
            const v = parseInt(src[propName])
            if (isNaN(v)) return
            if (minVal != null) {
                if (v < minVal) return
            }
            if (maxVal != null) {
                if (v > maxVal) return
            }
            dst[propName] = v
        } else {
            if (typeof def !== 'undefined') dst[propName] = def
        }
    }

    /**
     * Test a topic string is valid for subscription
     * @param {string} topic
     * @returns `true` if it is a valid topic
     */
    function isValidSubscriptionTopic (topic) {
        return /^(#$|(\+|[^+#]*)(\/(\+|[^+#]*))*(\/(\+|#|[^+#]*))?$)/.test(topic)
    }

    /**
     * Test a topic string is valid for publishing
     * @param {string} topic
     * @returns `true` if it is a valid topic
     */
    function isValidPublishTopic (topic) {
        if (topic.length === 0) return false
        // eslint-disable-next-line no-useless-escape
        return !/[\+#\b\f\n\r\t\v\0]/.test(topic)
    }

    /**
     * Helper function for setting string property values in the MQTT V5 properties object
     * @param {object} src Source object containing properties
     * @param {object} dst Destination object to set/add properties
     * @param {string} propName The property name to set in the Destination object
     * @param {string} [def] An optional default to set in the destination object if prop is NOT present in the soruce object
     */
    function setStrProp (src, dst, propName, def) {
        if (src[propName] && typeof src[propName] === 'string') {
            dst[propName] = src[propName]
        } else {
            if (typeof def !== 'undefined') dst[propName] = def
        }
    }

    /**
     * Helper function for setting boolean property values in the MQTT V5 properties object
     * @param {object} src Source object containing properties
     * @param {object} dst Destination object to set/add properties
     * @param {string} propName The property name to set in the Destination object
     * @param {boolean} [def] An optional default to set in the destination object if prop is NOT present in the soruce object
     */
    function setBoolProp (src, dst, propName, def) {
        if (src[propName] != null) {
            if (src[propName] === 'true' || src[propName] === true) {
                dst[propName] = true
            } else if (src[propName] === 'false' || src[propName] === false) {
                dst[propName] = false
            }
        } else {
            if (typeof def !== 'undefined') dst[propName] = def
        }
    }

    /**
     * Helper function for copying the MQTT v5 srcUserProperties object (parameter1) to the properties object (parameter2).
     * Any property in srcUserProperties that is NOT a key/string pair will be silently discarded.
     * NOTE: if no sutable properties are present, the userProperties object will NOT be added to the properties object
     * @param {object} srcUserProperties An object with key/value string pairs
     * @param {object} properties A properties object in which userProperties will be copied to
     */
    function setUserProperties (srcUserProperties, properties) {
        if (srcUserProperties && typeof srcUserProperties === 'object') {
            const _clone = {}
            let count = 0
            const keys = Object.keys(srcUserProperties)
            if (!keys || !keys.length) return null
            keys.forEach(key => {
                const val = srcUserProperties[key]
                if (typeof val === 'string') {
                    count++
                    _clone[key] = val
                } else if (val !== undefined && val !== null) {
                    try {
                        _clone[key] = JSON.stringify(val)
                        count++
                    } catch (err) {
                        // Silently drop property
                    }
                }
            })
            if (count) properties.userProperties = _clone
        }
    }

    /**
     * Helper function for copying the MQTT v5 buffer type properties
     * NOTE: if src[propName] is not a buffer, dst[propName] will NOT be assigned a value (unless def is set)
     * @param {object} src Source object containing properties
     * @param {object} dst Destination object to set/add properties
     * @param {string} propName The property name to set in the Destination object
     * @param {boolean} [def] An optional default to set in the destination object if prop is NOT present in the Source object
     */
    function setBufferProp (src, dst, propName, def) {
        if (!dst) return
        if (src && dst) {
            const buf = src[propName]
            if (buf && typeof Buffer.isBuffer(buf)) {
                dst[propName] = Buffer.from(buf)
            }
        } else {
            if (typeof def !== 'undefined') dst[propName] = def
        }
    }

    /**
     * Helper function for applying changes to an objects properties ONLY when the src object actually has the property.
     * This avoids setting a `dst` property null/undefined when the `src` object doesnt have the named property.
     * @param {object} src Source object containing properties
     * @param {object} dst Destination object to set property
     * @param {string} propName The property name to set in the Destination object
     * @param {boolean} force force the dst property to be updated/created even if src property is empty
     */
    function setIfHasProperty (src, dst, propName, force) {
        if (src && dst && propName) {
            const ok = force || hasProperty(src, propName)
            if (ok) {
                dst[propName] = src[propName]
            }
        }
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

    /**
     * Handle the payload / packet recieved in MQTT In and MQTT Sub nodes
     */
    function subscriptionHandler (node, datatype, topic, payload, packet) {
        const msg = { topic, payload: null, qos: packet.qos, retain: packet.retain }
        const v5 = (node && node.brokerConn)
            ? node.brokerConn.v5()
            : Object.prototype.hasOwnProperty.call(packet, 'properties')
        if (v5 && packet.properties) {
            setStrProp(packet.properties, msg, 'responseTopic')
            setBufferProp(packet.properties, msg, 'correlationData')
            setStrProp(packet.properties, msg, 'contentType')
            setIntProp(packet.properties, msg, 'messageExpiryInterval', 0)
            setBoolProp(packet.properties, msg, 'payloadFormatIndicator')
            setStrProp(packet.properties, msg, 'reasonString')
            setUserProperties(packet.properties.userProperties, msg)
        }
        const v5isUtf8 = v5 ? msg.payloadFormatIndicator === true : null
        const v5HasMediaType = v5 ? !!msg.contentType : null
        const v5MediaTypeLC = v5 ? (msg.contentType + '').toLowerCase() : null

        if (datatype === 'buffer') {
            // payload = payload;
        } else if (datatype === 'base64') {
            payload = payload.toString('base64')
        } else if (datatype === 'utf8') {
            payload = payload.toString('utf8')
        } else if (datatype === 'json') {
            if (v5isUtf8 || isUtf8(payload)) {
                try {
                    payload = JSON.parse(payload.toString())
                } catch (e) {
                    node.error(RED._('ff-mqtt.errors.invalid-json-parse'), { payload, topic, qos: packet.qos, retain: packet.retain }); return
                }
            } else {
                node.error((RED._('ff-mqtt.errors.invalid-json-string')), { payload, topic, qos: packet.qos, retain: packet.retain }); return
            }
        } else {
            // "auto" (legacy) or "auto-detect" (new default)
            if (v5isUtf8 || v5HasMediaType) {
                const outputType = knownMediaTypes[v5MediaTypeLC]
                switch (outputType) {
                case 'string':
                    payload = payload.toString()
                    break
                case 'buffer':
                    // no change
                    break
                case 'json':
                    try {
                        // since v5 type states this should be JSON, parse it & error out if NOT JSON
                        payload = payload.toString()
                        const obj = JSON.parse(payload)
                        if (datatype === 'auto-detect') {
                            payload = obj // as mode is "auto-detect", return the parsed JSON
                        }
                    } catch (e) {
                        node.error(RED._('ff-mqtt.errors.invalid-json-parse'), { payload, topic, qos: packet.qos, retain: packet.retain }); return
                    }
                    break
                default:
                    if (v5isUtf8 || isUtf8(payload)) {
                        payload = payload.toString() // auto String
                        if (datatype === 'auto-detect') {
                            try {
                                payload = JSON.parse(payload) // auto to parsed object (attempt)
                            } catch (e) {
                                /* mute error - it simply isnt JSON, just leave payload as a string */
                            }
                        }
                    }
                    break
                }
            } else if (isUtf8(payload)) {
                payload = payload.toString() // auto String
                if (datatype === 'auto-detect') {
                    try {
                        payload = JSON.parse(payload)
                    } catch (e) {
                        /* mute error - it simply isnt JSON, just leave payload as a string */
                    }
                }
            } // else {
            // leave as buffer
            // }
        }
        msg.payload = payload
        if (node.brokerConn && (node.brokerConn.broker === 'localhost' || node.brokerConn.broker === '127.0.0.1')) {
            msg._topic = topic
        }
        node.send(msg)
    }

    /**
     * Send an mqtt message to broker
     * @param {MQTTOutNode} node the owner node
     * @param {object} msg The msg to prepare for publishing
     * @param {function} done callback when done
     */
    function doPublish (node, msg, done) {
        try {
            done = typeof done === 'function' ? done : function noop () {}
            const v5 = node.brokerConn.options && +node.brokerConn.options.protocolVersion === 5

            // Sanitise the `msg` object properties ready for publishing
            if (msg.qos) {
                msg.qos = parseInt(msg.qos)
                if ((msg.qos !== 0) && (msg.qos !== 1) && (msg.qos !== 2)) {
                    msg.qos = null
                }
            }

            /* If node properties exists, override/set that to property in msg  */
            if (node.topic) { msg.topic = node.topic }
            msg.qos = Number(node.qos || msg.qos || 0)
            msg.retain = node.retain || msg.retain || false
            msg.retain = ((msg.retain === true) || (msg.retain === 'true')) || false

            if (v5) {
                if (node.userProperties) {
                    msg.userProperties = node.userProperties
                }
                if (node.responseTopic) {
                    msg.responseTopic = node.responseTopic
                }
                if (node.correlationData) {
                    msg.correlationData = node.correlationData
                }
                if (node.contentType) {
                    msg.contentType = node.contentType
                }
                if (node.messageExpiryInterval) {
                    msg.messageExpiryInterval = node.messageExpiryInterval
                }
            }
            if (hasProperty(msg, 'payload')) {
                // send the message
                node.brokerConn.publish(msg, function (err) {
                    if (err && err.warn) {
                        node.warn(err)
                        return
                    }
                    done(err)
                })
            } else {
                done()
            }
        } catch (error) {
            done(error)
        }
    }

    function updateStatus (node, allNodes) {
        let setStatus = setStatusDisconnected
        if (node.connecting) {
            setStatus = setStatusConnecting
        } else if (node.connected) {
            setStatus = setStatusConnected
        }
        setStatus(node, allNodes)
    }

    function setStatusDisconnected (node, allNodes) {
        if (allNodes) {
            for (const id in node.users) {
                if (hasProperty(node.users, id)) {
                    node.users[id].status({ fill: 'red', shape: 'ring', text: 'node-red:common.status.disconnected' })
                }
            }
        } else {
            node.status({ fill: 'red', shape: 'ring', text: 'node-red:common.status.disconnected' })
        }
    }

    function setStatusConnecting (node, allNodes) {
        if (allNodes) {
            for (const id in node.users) {
                if (hasProperty(node.users, id)) {
                    node.users[id].status({ fill: 'yellow', shape: 'ring', text: 'node-red:common.status.connecting' })
                }
            }
        } else {
            node.status({ fill: 'yellow', shape: 'ring', text: 'node-red:common.status.connecting' })
        }
    }

    function setStatusConnected (node, allNodes) {
        if (allNodes) {
            for (const id in node.users) {
                if (hasProperty(node.users, id)) {
                    node.users[id].status({ fill: 'green', shape: 'dot', text: 'node-red:common.status.connected' })
                }
            }
        } else {
            node.status({ fill: 'green', shape: 'dot', text: 'node-red:common.status.connected' })
        }
    }

    /**
     * Perform the connect action
     * @param {MQTTInNode|MQTTOutNode} node
     * @param {Object} msg
     * @param {Function} done
     */
    function handleConnectAction (node, msg, done) {
        const actionData = ALLOW_DYNAMIC_CONNECT_OPTIONS && (typeof msg.broker === 'object' ? msg.broker : null)
        if (node.brokerConn.canConnect()) {
            // Not currently connected/connecting - trigger the connect
            if (actionData) {
                node.brokerConn.setOptions(actionData)
            }
            node.brokerConn.connect(function () {
                done()
            })
        } else {
            // Already Connected/Connecting
            if (!actionData) {
                // All is good - already connected and no broker override provided
                done()
            } else if (actionData.force) {
                // The force flag tells us to cycle the connection.
                node.brokerConn.disconnect(function () {
                    node.brokerConn.setOptions(actionData)
                    node.brokerConn.connect(function () {
                        done()
                    })
                })
            } else {
                // Without force flag, we will refuse to cycle an active connection
                done(new Error(RED._('ff-mqtt.errors.invalid-action-alreadyconnected')))
            }
        }
    }

    /**
     * Perform the disconnect action
     * @param {MQTTInNode|MQTTOutNode} node
     * @param {Function} done
     */
    function handleDisconnectAction (node, done) {
        node.brokerConn.disconnect(function () {
            done()
        })
    }
    const unsubscribeCandidates = {}
    // #endregion  "Supporting functions"

    // #region  "Broker node"
    function MQTTBrokerNode (n) {
        /** @type {MQTTBrokerNode} */
        const node = this
        node._initialised = false
        node._initialising = false

        Object.defineProperty(node, 'initialised', {
            get: function () {
                return node._initialised
            }
        })
        Object.defineProperty(node, 'initialising', {
            get: function () {
                return node._initialising
            }
        })
        Object.defineProperty(node, 'linked', {
            get: function () {
                return node._linked
            }
        })
        Object.defineProperty(node, 'linkFailed', {
            get: function () {
                return node._linkFailed
            }
        })

        node.users = {}
        // Config node state
        node.brokerurl = ''
        node.connected = false
        node.connecting = false
        node.closing = false
        node.options = {}
        node.queue = []
        node.subscriptions = {}
        node.clientListeners = []
        /** @type {mqtt.MqttClient} */
        node.client = null
        node.linkPromise = null
        node._linked = false
        node._linkFailed = false

        node.link = async function () {
            if (node.linkPromise) {
                return node.linkPromise // already linking, return the existing promise
            }
            const teamBrokerApi = TeamBrokerApi.TeamBrokerApi(got, {
                forgeURL: forgeSettings.forgeURL,
                teamId,
                instanceType,
                instanceId,
                token: mqttSettings.token || ''
            })
            try {
                node.linkPromise = teamBrokerApi.link(mqttSettings.broker.password)
                await node.linkPromise
                node.linkPromise = null // reset the link promise
                node._linkFailed = false
                node._linked = true
                return node._linked
            } catch (err) {
                const code = err.code || err.statusCode || err.status || 'unknown'
                const name = err.name || 'UnknownError'
                const error = new Error(`Failed to link to FlowFuse broker: ${name} (${code})`, { cause: err })
                node._linkFailed = true
                node._linked = false
                throw error
            } finally {
                node.linkPromise = null // reset the link promise
            }
        }

        node.initialise = function () {
            try {
                if (node._initialising) {
                    return // already initialising, simply return
                }
                node._initialising = true

                const featureEnabled = forgeSettings.teamBrokerEnabled !== false
                if (!featureEnabled) {
                    throw new Error('Teambroker is not enabled in this FlowFuse EE environment')
                }
                const settings = {
                    url: mqttSettings.broker.url || ''
                }
                node.credentials = {
                    user: TEAM_CLIENT_AUTH_ID,
                    password: mqttSettings.broker.password || ''
                }
                settings.username = TEAM_CLIENT_AUTH_ID
                settings.password = mqttSettings.broker.password || ''
                settings.clientid = TEAM_CLIENT_CLIENT_ID
                settings.autoConnect = mqttSettings.autoConnect !== false
                settings.usetls = mqttSettings.usetls || false
                settings.compatmode = mqttSettings.compatmode || false
                settings.protocolVersion = mqttSettings.protocolVersion || 5
                settings.keepalive = mqttSettings.keepalive || 60
                settings.cleansession = mqttSettings.cleansession !== false // default to true
                settings.topicAliasMaximum = mqttSettings.topicAliasMaximum || 0
                node.setOptions(settings, true) // initial options
                node._initialised = true
            } catch (error) {
                node._initialised = false
                node.error(error)
                throw error // re-throw the error to stop initialisation
            } finally {
                node._initialising = false
            }
        }

        node.setOptions = function (opts, init) {
            if (!opts || typeof opts !== 'object') {
                return // nothing to change, simply return
            }
            // apply property changes (only if the property exists in the opts object)
            setIfHasProperty(opts, node, 'url', init)
            setIfHasProperty(opts, node, 'broker', init)
            setIfHasProperty(opts, node, 'port', init)
            setIfHasProperty(opts, node, 'clientid', init)
            setIfHasProperty(opts, node, 'autoConnect', init)
            setIfHasProperty(opts, node, 'usetls', init)
            setIfHasProperty(opts, node, 'verifyservercert', init)
            setIfHasProperty(opts, node, 'compatmode', init)
            setIfHasProperty(opts, node, 'protocolVersion', init)
            setIfHasProperty(opts, node, 'keepalive', init)
            setIfHasProperty(opts, node, 'cleansession', init)
            setIfHasProperty(opts, node, 'autoUnsubscribe', init)
            setIfHasProperty(opts, node, 'topicAliasMaximum', init)
            setIfHasProperty(opts, node, 'maximumPacketSize', init)
            setIfHasProperty(opts, node, 'receiveMaximum', init)
            // https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901116
            if (hasProperty(opts, 'userProperties')) {
                node.userProperties = opts.userProperties
            } else if (hasProperty(opts, 'userProps')) {
                node.userProperties = opts.userProps
            }
            if (hasProperty(opts, 'sessionExpiry')) {
                node.sessionExpiryInterval = opts.sessionExpiry
            } else if (hasProperty(opts, 'sessionExpiryInterval')) {
                node.sessionExpiryInterval = opts.sessionExpiryInterval
            }

            function createLWT (topic, payload, qos, retain, v5opts, v5SubPropName) {
                let message
                if (topic) {
                    message = {
                        topic,
                        payload: payload || '',
                        qos: Number(qos || 0),
                        retain: retain === 'true' || retain === true
                    }
                    if (v5opts) {
                        let v5Properties = message
                        if (v5SubPropName) {
                            v5Properties = message[v5SubPropName] = {}
                        }
                        // re-align local prop name to mqttjs std
                        if (hasProperty(v5opts, 'respTopic')) { v5opts.responseTopic = v5opts.respTopic }
                        if (hasProperty(v5opts, 'correl')) { v5opts.correlationData = v5opts.correl }
                        if (hasProperty(v5opts, 'expiry')) { v5opts.messageExpiryInterval = v5opts.expiry }
                        if (hasProperty(v5opts, 'delay')) { v5opts.willDelayInterval = v5opts.delay }
                        if (hasProperty(v5opts, 'userProps')) { v5opts.userProperties = v5opts.userProps }
                        // setup v5 properties
                        if (typeof v5opts.userProperties === 'string' && /^ *{/.test(v5opts.userProperties)) {
                            try {
                                setUserProperties(JSON.parse(v5opts.userProps), v5Properties)
                            } catch (err) {}
                        } else if (typeof v5opts.userProperties === 'object') {
                            setUserProperties(v5opts.userProperties, v5Properties)
                        }
                        setStrProp(v5opts, v5Properties, 'contentType')
                        setStrProp(v5opts, v5Properties, 'responseTopic')
                        setBufferProp(v5opts, v5Properties, 'correlationData')
                        setIntProp(v5opts, v5Properties, 'messageExpiryInterval')
                        setIntProp(v5opts, v5Properties, 'willDelayInterval')
                    }
                }
                return message
            }

            if (init) {
                if (hasProperty(opts, 'birthTopic')) {
                    node.birthMessage = createLWT(opts.birthTopic, opts.birthPayload, opts.birthQos, opts.birthRetain, opts.birthMsg, '')
                }
                if (hasProperty(opts, 'closeTopic')) {
                    node.closeMessage = createLWT(opts.closeTopic, opts.closePayload, opts.closeQos, opts.closeRetain, opts.closeMsg, '')
                }
                if (hasProperty(opts, 'willTopic')) {
                    // will v5 properties must be set in the "properties" sub object
                    node.options.will = createLWT(opts.willTopic, opts.willPayload, opts.willQos, opts.willRetain, opts.willMsg, 'properties')
                }
            } else {
                // update options
                if (hasProperty(opts, 'birth')) {
                    if (typeof opts.birth !== 'object') { opts.birth = {} }
                    node.birthMessage = createLWT(opts.birth.topic, opts.birth.payload, opts.birth.qos, opts.birth.retain, opts.birth.properties, '')
                }
                if (hasProperty(opts, 'close')) {
                    if (typeof opts.close !== 'object') { opts.close = {} }
                    node.closeMessage = createLWT(opts.close.topic, opts.close.payload, opts.close.qos, opts.close.retain, opts.close.properties, '')
                }
                if (hasProperty(opts, 'will')) {
                    if (typeof opts.will !== 'object') { opts.will = {} }
                    // will v5 properties must be set in the "properties" sub object
                    node.options.will = createLWT(opts.will.topic, opts.will.payload, opts.will.qos, opts.will.retain, opts.will.properties, 'properties')
                }
            }

            if (node.credentials) {
                node.username = node.credentials.user
                node.password = node.credentials.password
            }
            if (!init & hasProperty(opts, 'username')) {
                node.username = opts.username
            }
            if (!init & hasProperty(opts, 'password')) {
                node.password = opts.password
            }

            // If the config node is missing certain options (it was probably deployed prior to an update to the node code),
            // select/generate sensible options for the new fields
            if (typeof node.usetls === 'undefined') {
                node.usetls = false
            }
            if (typeof node.verifyservercert === 'undefined') {
                node.verifyservercert = false
            }
            if (typeof node.keepalive === 'undefined') {
                node.keepalive = 60
            } else if (typeof node.keepalive === 'string') {
                node.keepalive = Number(node.keepalive)
            }
            if (typeof node.cleansession === 'undefined') {
                node.cleansession = true
            }
            if (typeof node.autoUnsubscribe !== 'boolean') {
                node.autoUnsubscribe = true
            }
            // use url or build a url from usetls://broker:port
            if (node.url && node.brokerurl !== node.url) {
                node.brokerurl = node.url
            } else {
                // if the broker is ws:// or wss:// or tcp://
                if ((typeof node.broker === 'string') && node.broker.indexOf('://') > -1) {
                    node.brokerurl = node.broker
                    // Only for ws or wss, check if proxy env var for additional configuration
                    if (node.brokerurl.indexOf('wss://') > -1 || node.brokerurl.indexOf('ws://') > -1) {
                        // check if proxy is set in env
                        const agent = ProxyHelper.getWSProxyAgent(node.brokerurl)
                        if (agent) {
                            node.options.wsOptions = node.options.wsOptions || {}
                            node.options.wsOptions.agent = agent
                        }
                    }
                } else {
                    // construct the std mqtt:// url
                    if (node.usetls) {
                        node.brokerurl = 'mqtts://'
                    } else {
                        node.brokerurl = 'mqtt://'
                    }
                    if (node.broker !== '') {
                        // Check for an IPv6 address
                        if (/(?:^|(?<=\s))(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))(?=\s|$)/.test(node.broker)) {
                            node.brokerurl = node.brokerurl + '[' + node.broker + ']:'
                        } else {
                            node.brokerurl = node.brokerurl + node.broker + ':'
                        }
                        // port now defaults to 1883 if unset.
                        if (!node.port) {
                            node.brokerurl = node.brokerurl + '1883'
                        } else {
                            node.brokerurl = node.brokerurl + node.port
                        }
                    } else {
                        node.brokerurl = node.brokerurl + 'localhost:1883'
                    }
                }
            }

            // Ensure cleansession set if clientid not supplied
            if (!node.cleansession && !node.clientid) {
                node.cleansession = true
                node.warn(RED._('ff-mqtt.errors.nonclean-missingclientid'))
            }

            // Build options for passing to the MQTT.js API
            node.options.username = node.username
            node.options.password = node.password
            node.options.keepalive = node.keepalive
            node.options.clean = node.cleansession
            node.options.clientId = node.clientid || 'nodered' + RED.util.generateId()
            node.options.reconnectPeriod = RED.settings.mqttReconnectTime || 5000
            delete node.options.protocolId // V4+ default
            delete node.options.protocolVersion // V4 default
            delete node.options.properties// V5 only

            if (node.compatmode === 'true' || node.compatmode === true || +node.protocolVersion === 3) {
                node.options.protocolId = 'MQIsdp'// V3 compat only
                node.options.protocolVersion = 3
            } else if (+node.protocolVersion === 5) {
                delete node.options.protocolId
                node.options.protocolVersion = 5
                node.options.properties = {}
                node.options.properties.requestResponseInformation = true
                node.options.properties.requestProblemInformation = true
                if (node.userProperties && /^ *{/.test(node.userProperties)) {
                    try {
                        setUserProperties(JSON.parse(node.userProperties), node.options.properties)
                    } catch (err) {}
                }
                if (node.sessionExpiryInterval && node.sessionExpiryInterval !== '0') {
                    setIntProp(node, node.options.properties, 'sessionExpiryInterval')
                }
            }
            // Ensure will payload, if set, is a string
            if (node.options.will && Object.hasOwn(node.options.will, 'payload')) {
                let payload = node.options.will.payload
                if (payload === null || typeof payload === 'undefined') {
                    payload = ''
                } else if (!Buffer.isBuffer(payload)) {
                    if (typeof payload === 'object') {
                        payload = JSON.stringify(payload)
                    } else if (typeof payload !== 'string') {
                        payload = '' + payload
                    }
                }
                node.options.will.payload = payload
            }

            if (node.usetls && n.tls) {
                const tlsNode = RED.nodes.getNode(n.tls)
                if (tlsNode) {
                    tlsNode.addTLSOptions(node.options)
                }
            }

            // If there's no rejectUnauthorized already, then this could be an
            // old config where this option was provided on the broker node and
            // not the tls node
            if (typeof node.options.rejectUnauthorized === 'undefined') {
                node.options.rejectUnauthorized = (node.verifyservercert === 'true' || node.verifyservercert === true)
            }
        }
        node.v5 = () => node.options && +node.options.protocolVersion === 5
        node.subscriptionIdentifiersAvailable = () => node.v5() && node.serverProperties && node.serverProperties.subscriptionIdentifiersAvailable

        // n.autoConnect = !(n.autoConnect === 'false' || n.autoConnect === false)
        // node.setOptions(n, true)

        // Define functions called by MQTT in and out nodes
        node.registerAsync = async function (mqttNode) {
            node.users[mqttNode.id] = mqttNode
            if (Object.keys(node.users).length === 1) {
                try {
                    await node.link()
                    node.initialise()
                    node.connect()
                } catch (err) {
                    const error = new Error('Failed to initialize and connect FlowFuse MQTT node', { cause: err })
                    node.error(error)
                    setStatusDisconnected(node, true)
                } finally {
                    // update nodes status
                    setTimeout(function () {
                        updateStatus(node, true)
                    }, 1)
                }
            }
        }

        node.deregister = function (mqttNode, done, autoDisconnect) {
            setStatusDisconnected(mqttNode, false)
            delete node.users[mqttNode.id]
            if (autoDisconnect && !node.closing && node.connected && Object.keys(node.users).length === 0) {
                node.disconnect(done)
            } else {
                done()
            }
        }
        node.deregisterAsync = async function (mqttNode, autoDisconnect) {
            return new Promise((resolve, reject) => {
                node.deregister(mqttNode, (err) => {
                    if (err) {
                        reject(err)
                    } else {
                        resolve()
                    }
                }, autoDisconnect)
            })
        }
        node.canConnect = function () {
            return !node.connected && !node.connecting
        }
        node.connect = function (callback) {
            if (node.canConnect()) {
                node.closing = false
                node.connecting = true
                setStatusConnecting(node, true)
                try {
                    node.serverProperties = {}
                    if (node.client) {
                        // belt and braces to avoid left over clients
                        node.client.end(true)
                        node._clientRemoveListeners()
                    }
                    node.client = mqtt.connect(node.brokerurl, node.options)
                    node.client.setMaxListeners(0)
                    let callbackDone = false // prevent re-connects causing node._clientOn('connect' firing callback multiple times
                    // Register successful connect or reconnect handler
                    node._clientOn('connect', function (connack) {
                        node.closing = false
                        node.connecting = false
                        node.connected = true
                        if (!callbackDone && typeof callback === 'function') {
                            callback()
                        }
                        callbackDone = true
                        node.topicAliases = {}
                        node.log(RED._('ff-mqtt.state.connected', { broker: (node.clientid ? node.clientid + '@' : '') + node.brokerurl }))
                        if (+node.options.protocolVersion === 5 && connack && hasProperty(connack, 'properties')) {
                            if (typeof connack.properties === 'object') {
                                // clean & assign all props sent from server.
                                setIntProp(connack.properties, node.serverProperties, 'topicAliasMaximum', 0)
                                setIntProp(connack.properties, node.serverProperties, 'receiveMaximum', 0)
                                setIntProp(connack.properties, node.serverProperties, 'sessionExpiryInterval', 0, 0xFFFFFFFF)
                                setIntProp(connack.properties, node.serverProperties, 'maximumQoS', 0, 2)
                                setBoolProp(connack.properties, node.serverProperties, 'retainAvailable', true)
                                setBoolProp(connack.properties, node.serverProperties, 'wildcardSubscriptionAvailable', true)
                                setBoolProp(connack.properties, node.serverProperties, 'subscriptionIdentifiersAvailable', true)
                                setBoolProp(connack.properties, node.serverProperties, 'sharedSubscriptionAvailable')
                                setIntProp(connack.properties, node.serverProperties, 'maximumPacketSize', 0)
                                setIntProp(connack.properties, node.serverProperties, 'serverKeepAlive')
                                setStrProp(connack.properties, node.serverProperties, 'responseInformation')
                                setStrProp(connack.properties, node.serverProperties, 'serverReference')
                                setStrProp(connack.properties, node.serverProperties, 'assignedClientIdentifier')
                                setStrProp(connack.properties, node.serverProperties, 'reasonString')
                                setUserProperties(connack.properties, node.serverProperties)
                            }
                        }
                        setStatusConnected(node, true)
                        // Remove any existing listeners before resubscribing to avoid duplicates in the event of a re-connection
                        node._clientRemoveListeners('message')

                        // Re-subscribe to stored topics
                        for (const s in node.subscriptions) {
                            if (hasProperty(node.subscriptions, s)) {
                                for (const r in node.subscriptions[s]) {
                                    if (hasProperty(node.subscriptions[s], r)) {
                                        node.subscribe(node.subscriptions[s][r])
                                    }
                                }
                            }
                        }

                        // Send any birth message
                        if (node.birthMessage) {
                            setTimeout(() => {
                                node.publish(node.birthMessage)
                            }, 1)
                        }
                    })
                    node._clientOn('reconnect', function () {
                        setStatusConnecting(node, true)
                    })
                    // Broker Disconnect - V5 event
                    node._clientOn('disconnect', function (packet) {
                        // Emitted after receiving disconnect packet from broker. MQTT 5.0 feature.
                        const rc = (packet && packet.properties && packet.reasonCode) || packet.reasonCode
                        const rs = (packet && packet.properties && packet.properties.reasonString) || ''
                        const details = {
                            broker: (node.clientid ? node.clientid + '@' : '') + node.brokerurl,
                            reasonCode: rc,
                            reasonString: rs
                        }
                        node.connected = false
                        node.log(RED._('ff-mqtt.state.broker-disconnected', details))
                        setStatusDisconnected(node, true)
                    })
                    // Register disconnect handlers
                    node._clientOn('close', function () {
                        if (node.connected) {
                            node.connected = false
                            node.log(RED._('ff-mqtt.state.disconnected', { broker: (node.clientid ? node.clientid + '@' : '') + node.brokerurl }))
                            setStatusDisconnected(node, true)
                        } else if (node.connecting) {
                            node.log(RED._('ff-mqtt.state.connect-failed', { broker: (node.clientid ? node.clientid + '@' : '') + node.brokerurl }))
                        }
                    })

                    // Register connect error handler
                    // The client's own reconnect logic will take care of errors
                    // eslint-disable-next-line n/handle-callback-err
                    node._clientOn('error', function (error) {
                    })
                } catch (err) {
                    // eslint-disable-next-line no-console
                    console.log(err)
                }
            }
        }

        node.disconnect = function (callback) {
            const _callback = function () {
                if (node.connected || node.connecting) {
                    setStatusDisconnected(node, true)
                }
                if (node.client) { node._clientRemoveListeners() }
                node.connecting = false
                node.connected = false
                callback && typeof callback === 'function' && callback()
            }
            if (!node.client) { return _callback() }
            if (node.closing) { return _callback() }

            /**
             * Call end and wait for the client to end (or timeout)
             * @param {mqtt.MqttClient} client The broker client
             * @param {number} ms The time to wait for the client to end
             * @returns
             */
            const waitEnd = (client, ms) => {
                return new Promise((resolve, reject) => {
                    node.closing = true
                    if (!client) {
                        resolve()
                    } else {
                        const t = setTimeout(() => {
                            // clean end() has exceeded WAIT_END, lets force end!
                            client && client.end(true)
                            resolve()
                        }, ms)
                        client.end(() => {
                            clearTimeout(t)
                            resolve()
                        })
                    }
                })
            }
            if (node.connected && node.closeMessage) {
                node.publish(node.closeMessage, function (_err) {
                    waitEnd(node.client, 2000).then(() => {
                        _callback()
                    }).catch((e) => {
                        _callback()
                    })
                })
            } else {
                waitEnd(node.client, 2000).then(() => {
                    _callback()
                }).catch((e) => {
                    _callback()
                })
            }
        }
        node.subscriptionIds = {}
        node.subid = 1

        // typedef for subscription object:
        /**
         * @typedef {Object} Subscription
         * @property {String} topic - topic to subscribe to
         * @property {Object} [options] - options object
         * @property {Number} [options.qos] - quality of service
         * @property {Number} [options.nl] - no local
         * @property {Number} [options.rap] - retain as published
         * @property {Number} [options.rh] - retain handling
         * @property {Number} [options.properties] - MQTT 5.0 properties
         * @property {Number} [options.properties.subscriptionIdentifier] - MQTT 5.0 subscription identifier
         * @property {Number} [options.properties.userProperties] - MQTT 5.0 user properties
         * @property {Function} callback
         * @property {String} ref - reference to the node that created the subscription
         */

        /**
         * Create a subscription object
         * @param {String} _topic - topic to subscribe to
         * @param {Object} _options - options object
         * @param {String} _ref - reference to the node that created the subscription
         * @returns {Subscription}
         */
        function createSubscriptionObject (_topic, _options, _ref, _brokerId) {
            /** @type {Subscription} */
            const subscription = {}
            const ref = _ref || 0
            let options
            let qos = 1 // default to QoS 1 (AWS and several other brokers don't support QoS 2)

            // if options is an object, then clone it
            if (typeof _options === 'object') {
                options = RED.util.cloneMessage(_options || {})
                qos = _options.qos
            } else if (typeof _options === 'number') {
                qos = _options
            }
            options = options || {}

            // sanitise qos
            if (typeof qos === 'number' && qos >= 0 && qos <= 2) {
                options.qos = qos
            }

            subscription.topic = _topic
            subscription.qos = qos
            subscription.options = RED.util.cloneMessage(options)
            subscription.ref = ref
            subscription.brokerId = _brokerId
            return subscription
        }

        /**
         * If topic is a subscription object, then use that, otherwise look up the topic in
         * the  subscriptions object.  If the topic is not found, then create a new subscription
         * object and add it to the subscriptions object.
         * @param {Subscription|String} topic
         * @param {*} options
         * @param {*} callback
         * @param {*} ref
         */
        node.subscribe = function (topic, options, callback, ref) {
            /** @type {Subscription} */
            let subscription
            let doCompare = false
            let changesFound = false

            // function signature 1: subscribe(subscription: Subscription)
            if (typeof topic === 'object' && topic !== null) {
                subscription = topic
                topic = subscription.topic
                options = subscription.options
                ref = subscription.ref
                callback = subscription.callback
            }

            // function signature 2: subscribe(topic: String, options: Object, callback: Function, ref: String)
            else if (typeof topic === 'string') {
                // since this is a call where all params are provided, it might be
                // a node change (modification) so we need to check for changes
                doCompare = true
                subscription = node.subscriptions[topic] && node.subscriptions[topic][ref]
            }

            // bad function call
            else {
                console.warn('Invalid call to node.subscribe')
                return
            }
            const thisBrokerId = node.type === 'mqtt-broker' ? node.id : node.broker

            // unsubscribe topics where the broker has changed
            const oldBrokerSubs = (unsubscribeCandidates[ref] || []).filter(sub => sub.brokerId !== thisBrokerId)
            oldBrokerSubs.forEach(sub => {
                /** @type {MQTTBrokerNode} */
                const _brokerConn = node // RED.nodes.getNode(sub.brokerId)
                if (_brokerConn) {
                    _brokerConn.unsubscribe(sub.topic, sub.ref, true)
                }
            })

            // if subscription is found (or sent in as a parameter), then check for changes.
            // if there are any changes requested, tidy up the old subscription
            if (subscription) {
                if (doCompare) {
                    // compare the current sub to the passed in parameters. Use RED.util.compareObjects against
                    // only the minimal set of properties to identify if the subscription has changed
                    const currentSubscription = createSubscriptionObject(subscription.topic, subscription.options, subscription.ref)
                    const newSubscription = createSubscriptionObject(topic, options, ref)
                    changesFound = RED.util.compareObjects(currentSubscription, newSubscription) === false
                }
            }

            if (changesFound) {
                if (subscription.handler) {
                    node._clientRemoveListeners('message', subscription.handler)
                    subscription.handler = null
                }
                const _brokerConn = node // RED.nodes.getNode(subscription.brokerId)
                if (_brokerConn) {
                    _brokerConn.unsubscribe(subscription.topic, subscription.ref, true)
                }
            }

            // clean up the unsubscribe candidate list
            delete unsubscribeCandidates[ref]

            // determine if this is an existing subscription
            const existingSubscription = typeof subscription === 'object' && subscription !== null

            // if existing subscription is not found or has changed, create a new subscription object
            if (existingSubscription === false || changesFound) {
                subscription = createSubscriptionObject(topic, options, ref, node.id)
            }

            // setup remainder of subscription properties and event handling
            node.subscriptions[topic] = node.subscriptions[topic] || {}
            node.subscriptions[topic][ref] = subscription
            if (!node.subscriptionIds[topic]) {
                node.subscriptionIds[topic] = node.subid++
            }
            subscription.options = subscription.options || {}
            subscription.options.properties = options.properties || {}
            subscription.options.properties.subscriptionIdentifier = node.subscriptionIds[topic]
            subscription.callback = callback

            // if the client is connected, then setup the handler and subscribe
            if (node.connected) {
                const subIdsAvailable = node.subscriptionIdentifiersAvailable()

                if (!subscription.handler) {
                    subscription.handler = function (mtopic, mpayload, mpacket) {
                        const sops = subscription.options ? subscription.options.properties : {}
                        const pops = mpacket.properties || {}
                        if (subIdsAvailable && pops.subscriptionIdentifier && sops.subscriptionIdentifier && (pops.subscriptionIdentifier !== sops.subscriptionIdentifier)) {
                            // do nothing as subscriptionIdentifier does not match
                        } else if (matchTopic(topic, mtopic)) {
                            subscription.callback && subscription.callback(mtopic, mpayload, mpacket)
                        }
                    }
                }
                node._clientOn('message', subscription.handler)
                // if the broker doesn't support subscription identifiers, then don't send them (AWS support)
                if (subscription.options.properties && subscription.options.properties.subscriptionIdentifier && subIdsAvailable !== true) {
                    delete subscription.options.properties.subscriptionIdentifier
                }
                node.client.subscribe(topic, subscription.options, function (err, granted) {
                    if (err) {
                        node.error(RED._('ff-mqtt.errors.subscribe-failed', { topic, error: err.message }), { topic })
                    }
                })
            }
        }

        node.unsubscribe = function (topic, ref, removeClientSubscription) {
            ref = ref || 0
            const unsub = removeClientSubscription || node.autoUnsubscribe !== false
            const sub = node.subscriptions[topic]
            let brokerId = node.id
            if (sub) {
                if (sub[ref]) {
                    brokerId = sub[ref].brokerId || brokerId
                    if (node.client && sub[ref].handler) {
                        node._clientRemoveListeners('message', sub[ref].handler)
                        sub[ref].handler = null
                    }
                    if (unsub) {
                        delete sub[ref]
                    }
                }
                // if instructed to remove the actual MQTT client subscription
                if (unsub) {
                    // if there are no more subscriptions for the topic, then remove the topic
                    if (Object.keys(sub).length === 0) {
                        try {
                            node.client.unsubscribe(topic)
                        } catch (_err) {
                            // do nothing
                        } finally {
                            // remove unsubscribe candidate as it is now REALLY unsubscribed
                            delete node.subscriptions[topic]
                            delete node.subscriptionIds[topic]
                            if (unsubscribeCandidates[ref]) {
                                unsubscribeCandidates[ref] = unsubscribeCandidates[ref].filter(sub => sub.topic !== topic)
                            }
                        }
                    }
                } else {
                    // if instructed to not remove the client subscription, then add it to the candidate list
                    // of subscriptions to be removed when the the same ref is used in a subsequent subscribe
                    // and the topic has changed
                    unsubscribeCandidates[ref] = unsubscribeCandidates[ref] || []
                    unsubscribeCandidates[ref].push({
                        topic,
                        ref,
                        brokerId
                    })
                }
            }
        }
        node.topicAliases = {}

        node.publish = function (msg, done) {
            if (node.connected) {
                if (msg.payload === null || msg.payload === undefined) {
                    msg.payload = ''
                } else if (!Buffer.isBuffer(msg.payload)) {
                    if (typeof msg.payload === 'object') {
                        msg.payload = JSON.stringify(msg.payload)
                    } else if (typeof msg.payload !== 'string') {
                        msg.payload = '' + msg.payload
                    }
                }
                const options = {
                    qos: msg.qos || 0,
                    retain: msg.retain || false
                }
                let topicOK = hasProperty(msg, 'topic') && (typeof msg.topic === 'string') && (isValidPublishTopic(msg.topic))
                // https://github.com/mqttjs/MQTT.js/blob/master/README.md#mqttclientpublishtopic-message-options-callback
                if (+node.options.protocolVersion === 5) {
                    const bsp = node.serverProperties || {}
                    if (msg.userProperties && typeof msg.userProperties !== 'object') {
                        delete msg.userProperties
                    }
                    if (hasProperty(msg, 'topicAlias') && !isNaN(Number(msg.topicAlias))) {
                        msg.topicAlias = parseInt(msg.topicAlias)
                    } else {
                        delete msg.topicAlias
                    }
                    options.properties = options.properties || {}
                    setStrProp(msg, options.properties, 'responseTopic')
                    setBufferProp(msg, options.properties, 'correlationData')
                    setStrProp(msg, options.properties, 'contentType')
                    setIntProp(msg, options.properties, 'messageExpiryInterval', 0)
                    setUserProperties(msg.userProperties, options.properties)
                    setIntProp(msg, options.properties, 'topicAlias', 1, bsp.topicAliasMaximum || 0)
                    setBoolProp(msg, options.properties, 'payloadFormatIndicator')
                    // FUTURE setIntProp(msg, options.properties, "subscriptionIdentifier", 1, 268435455);

                    // check & sanitise topic
                    if (topicOK && options.properties.topicAlias) {
                        const aliasValid = (bsp.topicAliasMaximum && bsp.topicAliasMaximum >= options.properties.topicAlias)
                        if (!aliasValid) {
                            done('Invalid topicAlias')
                            return
                        }
                        if (node.topicAliases[options.properties.topicAlias] === msg.topic) {
                            msg.topic = ''
                        } else {
                            node.topicAliases[options.properties.topicAlias] = msg.topic
                        }
                    } else if (!msg.topic && options.properties.responseTopic) {
                        msg.topic = msg.responseTopic
                        topicOK = isValidPublishTopic(msg.topic)
                        delete msg.responseTopic // prevent responseTopic being resent?
                    }
                }

                if (topicOK) {
                    node.client.publish(msg.topic, msg.payload, options, function (err) {
                        if (done) {
                            done(err)
                        } else if (err) {
                            node.error(err, msg)
                        }
                    })
                } else {
                    const error = new Error(RED._('ff-mqtt.errors.invalid-topic'))
                    error.warn = true
                    if (done) {
                        done(error)
                    } else {
                        node.warn(error, msg)
                    }
                }
            }
        }

        // no `on` or `close` handlers for the static broker node
        // node.on('close', function (done) {
        //     node.disconnect(function () {
        //         done()
        //     })
        // })

        // fake the node.status function if it is not already defined
        if (typeof node.status !== 'function') {
            /** @type {function} */
            node.status = (options) => options
        }
        // mimic the node.warn function if it is not already defined
        if (typeof node.warn !== 'function') {
            /** @type {function} */
            node.warn = (msg) => {
                if (typeof msg === 'string') {
                    msg = `[ff-mqtt-broker] ${msg}`
                }
                RED.log.warn(msg)
            }
        }
        // mimic the node.error function if it is not already defined
        if (typeof node.error !== 'function') {
            /** @type {function} */
            node.error = (msg, _msg) => {
                if (typeof msg === 'string') {
                    msg = `[ff-mqtt-broker] ${msg}`
                } else if (typeof msg === 'object' && msg.message) {
                    msg = `[ff-mqtt-broker] ${msg.message}`
                }
                RED.log.error(msg, _msg)
            }
        }
        // mimic the node.log function if it is not already defined
        if (typeof node.log !== 'function') {
            /** @type {function} */
            node.log = (msg) => {
                if (typeof msg === 'string') {
                    msg = `[ff-mqtt-broker] ${msg}`
                }
                RED.log.info(msg)
            }
        }

        /**
         * Add event handlers to the MQTT.js client and track them so that
         * we do not remove any handlers that the MQTT client uses internally.
         * Use {@link node._clientRemoveListeners `node._clientRemoveListeners`} to remove handlers
         * @param {string} event The name of the event
         * @param {function} handler The handler for this event
         */
        node._clientOn = function (event, handler) {
            node.clientListeners.push({ event, handler })
            node.client.on(event, handler)
        }

        /**
         * Remove event handlers from the MQTT.js client & only the events
         * that we attached in {@link node._clientOn `node._clientOn`}.
         * * If `event` is omitted, then all events matching `handler` are removed
         * * If `handler` is omitted, then all events named `event` are removed
         * * If both parameters are omitted, then all events are removed
         * @param {string} [event] The name of the event (optional)
         * @param {function} [handler] The handler for this event (optional)
         */
        node._clientRemoveListeners = function (event, handler) {
            node.clientListeners = node.clientListeners.filter((l) => {
                if (event && event !== l.event) { return true }
                if (handler && handler !== l.handler) { return true }
                node.client.removeListener(l.event, l.handler)
                return false // found and removed, filter out this one
            })
        }
    }

    // #endregion  "Broker node"

    // #region MQTTIn node
    function MQTTInNode (n) {
        RED.nodes.createNode(this, n)
        /** @type {MQTTInNode} */const node = this

        /** @type {MQTTBrokerNode} */node.brokerConn = sharedBroker // RED.nodes.getNode(node.broker)

        node.dynamicSubs = {}
        node.isDynamic = hasProperty(n, 'inputs') && +n.inputs === 1
        node.inputs = n.inputs
        node.topic = n.topic
        node.qos = parseInt(n.qos)
        node.subscriptionIdentifier = n.subscriptionIdentifier// https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901117
        node.nl = n.nl
        node.rap = n.rap
        node.rh = n.rh

        const Actions = {
            CONNECT: 'connect',
            DISCONNECT: 'disconnect',
            SUBSCRIBE: 'subscribe',
            UNSUBSCRIBE: 'unsubscribe',
            GETSUBS: 'getSubscriptions'
        }
        const allowableActions = Object.values(Actions)

        if (isNaN(node.qos) || node.qos < 0 || node.qos > 2) {
            node.qos = 2
        }
        if (!node.isDynamic && !isValidSubscriptionTopic(node.topic)) {
            return node.warn(RED._('ff-mqtt.errors.invalid-topic'))
        }
        node.datatype = n.datatype || 'utf8'
        if (node.brokerConn) {
            setStatusDisconnected(node)
            if (node.topic || node.isDynamic) {
                node.brokerConn.registerAsync(node).then(() => {
                    if (!node.isDynamic) {
                        const options = { qos: node.qos }
                        const v5 = node.brokerConn.options && +node.brokerConn.options.protocolVersion === 5
                        if (v5) {
                            setIntProp(node, options, 'rh', 0, 2, 0)
                            if (node.nl === 'true' || node.nl === true) options.nl = true
                            else if (node.nl === 'false' || node.nl === false) options.nl = false
                            if (node.rap === 'true' || node.rap === true) options.rap = true
                            else if (node.rap === 'false' || node.rap === false) options.rap = false
                        }
                        node._topic = node.topic // store the original topic incase node is later changed
                        node.brokerConn.subscribe(node.topic, options, function (topic, payload, packet) {
                            subscriptionHandler(node, node.datatype, topic, payload, packet)
                        }, node.id)
                    }
                    if (node.brokerConn.connected) {
                        node.status({ fill: 'green', shape: 'dot', text: 'node-red:common.status.connected' })
                    }
                }).catch((err) => {
                    node.error(err)
                    setStatusDisconnected(node, true)
                })
            } else {
                node.error(RED._('ff-mqtt.errors.not-defined'))
            }
            node.on('input', function (msg, send, done) {
                const v5 = node.brokerConn.options && +node.brokerConn.options.protocolVersion === 5
                const action = msg.action

                if (!allowableActions.includes(action)) {
                    done(new Error(RED._('ff-mqtt.errors.invalid-action-action')))
                    return
                }

                if (action === Actions.CONNECT) {
                    handleConnectAction(node, msg, done)
                } else if (action === Actions.DISCONNECT) {
                    handleDisconnectAction(node, done)
                } else if (action === Actions.SUBSCRIBE || action === Actions.UNSUBSCRIBE) {
                    const subscriptions = []
                    let actionData
                    // coerce msg.topic into an array of strings or objects (for later iteration)
                    if (action === Actions.UNSUBSCRIBE && msg.topic === true) {
                        actionData = Object.values(node.dynamicSubs)
                    } else if (Array.isArray(msg.topic)) {
                        actionData = msg.topic
                    } else if (typeof msg.topic === 'string' || typeof msg.topic === 'object') {
                        actionData = [msg.topic]
                    } else {
                        done(new Error(RED._('ff-mqtt.errors.invalid-action-badsubscription')))
                        return
                    }
                    // ensure each subscription is an object with topic etc
                    for (let index = 0; index < actionData.length; index++) {
                        let subscription = actionData[index]
                        if (typeof subscription === 'string') {
                            subscription = { topic: subscription }
                        }
                        if (!subscription.topic || !isValidSubscriptionTopic(subscription.topic)) {
                            done(new Error(RED._('ff-mqtt.errors.invalid-topic')))
                            return
                        }
                        subscriptions.push(subscription)
                    }
                    if (action === Actions.UNSUBSCRIBE) {
                        subscriptions.forEach(function (sub) {
                            node.brokerConn.unsubscribe(sub.topic, node.id, true)
                            delete node.dynamicSubs[sub.topic]
                        })
                        // user can access current subscriptions through the complete node is so desired
                        msg.subscriptions = Object.values(node.dynamicSubs)
                        done()
                    } else if (action === Actions.SUBSCRIBE) {
                        subscriptions.forEach(function (sub) {
                            // always unsubscribe before subscribe to prevent multiple subs to same topic
                            if (node.dynamicSubs[sub.topic]) {
                                node.brokerConn.unsubscribe(sub.topic, node.id, true)
                                delete node.dynamicSubs[sub.topic]
                            }

                            // prepare options. Default qos 2 & rap flag true (same as 'mqtt in' node ui defaults when adding to editor)
                            const options = {}
                            setIntProp(sub, options, 'qos', 0, 2, 2)// default to qos 2 (same as 'mqtt in' default)
                            sub.qos = options.qos
                            if (v5) {
                                setIntProp(sub, options, 'rh', 0, 2, 0) // default rh to 0:send retained messages (same as 'mqtt in' default)
                                sub.rh = options.rh
                                setBoolProp(sub, options, 'rap', true) // default rap to true:Keep retain flag of original publish (same as 'mqtt in' default)
                                sub.rap = options.rap
                                if (sub.nl === 'true' || sub.nl === true) {
                                    options.nl = true
                                    sub.nl = true
                                } else if (sub.nl === 'false' || sub.nl === false) {
                                    options.nl = false
                                    sub.nl = false
                                } else {
                                    delete sub.nl
                                }
                            }

                            // subscribe to sub.topic & hook up subscriptionHandler
                            node.brokerConn.subscribe(sub.topic, options, function (topic, payload, packet) {
                                subscriptionHandler(node, sub.datatype || node.datatype, topic, payload, packet)
                            }, node.id)
                            node.dynamicSubs[sub.topic] = sub // save for later unsubscription & 'list' action
                        })
                        // user can access current subscriptions through the complete node is so desired
                        msg.subscriptions = Object.values(node.dynamicSubs)
                        done()
                    }
                } else if (action === Actions.GETSUBS) {
                    // send list of subscriptions in payload
                    msg.topic = 'subscriptions'
                    msg.payload = Object.values(node.dynamicSubs)
                    send(msg)
                    done()
                }
            })

            node.on('close', async function (removed, done) {
                try {
                    if (node.linkPromise) {
                        await node.linkPromise
                    }
                } catch (_error) {
                    // do nothing, just ensure that the linkPromise is resolved before closing
                }
                try {
                    if (node.isDynamic) {
                        Object.keys(node.dynamicSubs).forEach(function (topic) {
                            node.brokerConn.unsubscribe(topic, node.id, removed)
                        })
                        node.dynamicSubs = {}
                    } else {
                        node.brokerConn.unsubscribe(node.topic, node.id, removed)
                    }
                    if (node.brokerConn) {
                        await node.brokerConn.deregisterAsync(node, removed)
                        node.brokerConn = null
                    }
                } finally {
                    done()
                }
            })
        } else {
            node.error(RED._('ff-mqtt.errors.missing-config'))
        }
    }

    RED.nodes.registerType('ff-mqtt-in', MQTTInNode, {
        settings: {
            ffMqttInForgeUrl: {
                value: forgeSettings.forgeURL,
                exportable: true // make available in the editor
            },
            ffMqttInInstanceId: {
                value: instanceId,
                exportable: true // make available in the editor
            },
            ffMqttInInstanceType: {
                value: instanceType,
                exportable: true // make available in the editor
            },
            ffMqttInUserTeamBrokerClientUrl: {
                value: `${forgeSettings.forgeURL}/team-by-id/${teamId}/brokers/team-broker/client?searchQuery=${instanceId}`,
                exportable: true // make available in the editor
            }

        }
    })
    // #endregion  "MQTTIn node"

    // #region "MQTTOut node"
    function MQTTOutNode (n) {
        RED.nodes.createNode(this, n)
        const node = this
        node.topic = n.topic
        node.qos = n.qos || null
        node.retain = n.retain

        node.responseTopic = n.respTopic// https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901114
        node.correlationData = n.correl// https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901115
        node.contentType = n.contentType// https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901118
        node.messageExpiryInterval = n.expiry // https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901112
        try {
            if (/^ *{/.test(n.userProps)) {
                // setup this.userProperties
                setUserProperties(JSON.parse(n.userProps), node)// https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901116
            }
        } catch (err) {}
        // node.topicAlias = n.topicAlias; //https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901113
        // node.payloadFormatIndicator = n.payloadFormatIndicator; //https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901111
        // node.subscriptionIdentifier = n.subscriptionIdentifier;//https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901117

        /** @type {MQTTBrokerNode} */node.brokerConn = sharedBroker // RED.nodes.getNode(node.broker)

        const Actions = {
            CONNECT: 'connect',
            DISCONNECT: 'disconnect'
        }

        if (node.brokerConn) {
            setStatusDisconnected(node)
            node.on('input', function (msg, send, done) {
                if (msg.action) {
                    if (msg.action === Actions.CONNECT) {
                        handleConnectAction(node, msg, done)
                    } else if (msg.action === Actions.DISCONNECT) {
                        handleDisconnectAction(node, done)
                    } else {
                        done(new Error(RED._('ff-mqtt.errors.invalid-action-action')))
                    }
                } else {
                    doPublish(node, msg, done)
                }
            })
            if (node.brokerConn.connected) {
                node.status({ fill: 'green', shape: 'dot', text: 'node-red:common.status.connected' })
            }
            node.brokerConn.registerAsync(node)
            node.on('close', async function (removed, done) {
                try {
                    if (node.linkPromise) {
                        await node.linkPromise
                    }
                } catch (_error) {
                    // do nothing, just ensure that the linkPromise is resolved before closing
                }
                try {
                    if (node.brokerConn) {
                        await node.brokerConn.deregisterAsync(node, removed)
                        node.brokerConn = null
                    }
                } finally {
                    done()
                }
            })
        } else {
            node.error(RED._('ff-mqtt.errors.missing-config'))
        }
    }
    RED.nodes.registerType('ff-mqtt-out', MQTTOutNode, {
        settings: {
            ffMqttOutForgeUrl: {
                value: forgeSettings.forgeURL,
                exportable: true // make available in the editor
            },
            ffMqttOutInstanceId: {
                value: instanceId,
                exportable: true // make available in the editor
            },
            ffMqttOutInstanceType: {
                value: instanceType,
                exportable: true // make available in the editor
            },
            ffMqttOutUserTeamBrokerClientUrl: {
                value: `${forgeSettings.forgeURL}/team-by-id/${teamId}/brokers/team-broker/client?searchQuery=${instanceId}`,
                exportable: true // make available in the editor
            }
        }
    })
    // #endregion "MQTTOut node"
}
