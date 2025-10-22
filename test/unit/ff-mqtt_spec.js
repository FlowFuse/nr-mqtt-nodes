/*
This is a fork of the MQTT nodes from Node-RED.
The original code can be found at:
https://github.com/node-red/node-red/blob/f43d4e946523a797e7489deb46fed9ca78b70c6d/test/nodes/core/network/21-mqtt_spec.js
### Changes:
- lint errors fixed up
*/

'use strict'
const should = require('should')
const sinon = require('sinon')
const helper = require('node-red-node-test-helper')
const TeamBrokerApi = require('../../nodes/lib/TeamBrokerApi.js')
const mqttNodes = require('../../nodes/ff-mqtt.js')
const BROKER_HOST = process.env.MQTT_BROKER_SERVER || 'mqtt://localhost'
const BROKER_PORT = process.env.MQTT_BROKER_PORT || 1883
// By default, MQTT tests are disabled. Set ENV VAR  NR_MQTT_TESTS  to "1" or "true" to enable
const skipTests = process.env.NR_MQTT_TESTS !== 'true' && process.env.NR_MQTT_TESTS !== '1'
// const testUtils = require('nr-test-utils')
const RED = require('node-red/lib/red')

describe('FF MQTT Nodes', function () {
    before(function (done) {
        helper.startServer(done)
    })

    beforeEach(function () {
        setupDefaultForgeSettings({ forgeUrl: 'http://localhost:3000' })
        mockTeamBrokerApi(RED, null, { forgeURL: 'http://localhost:3000' })
    })

    after(function (done) {
        helper.stopServer(done)
    })

    afterEach(function () {
        sinon.restore()
        TeamBrokerApi.TeamBrokerApi = TeamBrokerApi._teamBrokerApi
        delete TeamBrokerApi._teamBrokerApi
        const mqttIn = helper.getNode('mqtt.in')
        const mqttOut = helper.getNode('mqtt.out')
        const brokerConn = mqttIn?.brokerConn || mqttOut?.brokerConn
        if (brokerConn) {
            clearInterval(brokerConn.linkMonitorInterval)
            brokerConn.disconnect()
        }
        try {
            helper.unload()
        } catch (error) { }
    })

    function mockTeamBrokerApi (RED, gotClient, { forgeURL, teamId, instanceType = 'application', instanceId = 'application-id', token, API_VERSION = 'v1' } = {}) {
        TeamBrokerApi._teamBrokerApi = TeamBrokerApi.TeamBrokerApi
        TeamBrokerApi.TeamBrokerApi = sinon.stub().callsFake(function (RED, gotClient, settings) {
            const api = {
                link: sinon.stub().callsFake(async function (password) {
                    return { }
                })
            }
            return api
        })
    }

    function setupDefaultForgeSettings ({ forgeURL, teamID, applicationID, projectID, deviceID, useSharedSubscriptions, broker } = {}) {
        RED.settings.flowforge = {
            forgeURL: forgeURL || 'http://localhost:3000',
            teamID: teamID || 'team-id',
            applicationID: applicationID || 'application-id',
            projectID: projectID || 'project-id',
            deviceID: deviceID || null
        }
        RED.settings.flowforge.projectLink = {
            useSharedSubscriptions: useSharedSubscriptions || false,
            broker: broker || {
                url: BROKER_HOST,
                username: null,
                password: null
            }
        }
    }

    it('should not be loaded without FF settings', async function () {
        this.timeout = 2000
        const { flow } = buildBasicMQTTSendRecvFlow({ id: 'mqtt.in', topic: 'in_topic' }, { id: 'mqtt.out', topic: 'out_topic' })

        RED.settings.flowforge = null // no settings
        should(helper.load(mqttNodes, flow)).be.rejectedWith('FlowFuse MQTT nodes cannot be loaded outside of an FlowFuse EE environment')

        setupDefaultForgeSettings()
        RED.settings.flowforge.forgeURL = null // no url
        should(helper.load(mqttNodes, flow)).be.rejectedWith('FlowFuse MQTT nodes cannot be loaded outside of an FlowFuse EE environment')

        setupDefaultForgeSettings()
        RED.settings.flowforge.teamID = null // no teamID
        should(helper.load(mqttNodes, flow)).be.rejectedWith('FlowFuse MQTT nodes cannot be loaded outside of an FlowFuse EE environment')

        setupDefaultForgeSettings()
        RED.settings.flowforge.broker = null
        should(helper.load(mqttNodes, flow)).be.rejectedWith('FlowFuse MQTT nodes cannot be loaded without a broker configured in FlowFuse EE settings')

        setupDefaultForgeSettings()
        RED.settings.flowforge.projectID = null // no projectID
        should(helper.load(mqttNodes, flow)).be.rejectedWith('FlowFuse MQTT nodes cannot be loaded due to missing instance information')
    })

    it('should be loaded and have default values', async function () {
        this.timeout = 2000
        const { flow } = buildBasicMQTTSendRecvFlow({ id: 'mqtt.in', topic: 'in_topic' }, { id: 'mqtt.out', topic: 'out_topic' })
        await helper.load(mqttNodes, flow)

        const mqttIn = helper.getNode('mqtt.in')
        const mqttOut = helper.getNode('mqtt.out')

        should(mqttIn).be.type('object', 'mqtt in node should be an object')
        mqttIn.should.have.property('datatype', 'utf8') // default: 'utf8'
        mqttIn.should.have.property('isDynamic', false) // default: false
        mqttIn.should.have.property('inputs', 0) // default: 0
        mqttIn.should.have.property('qos', 2) // default: 2
        mqttIn.should.have.property('topic', 'in_topic')
        mqttIn.should.have.property('wires', [['helper.node']])
        mqttIn.should.have.property('brokerConn').and.be.type('object')

        should(mqttOut).be.type('object', 'mqtt out node should be an object')
        mqttOut.should.have.property('topic', 'out_topic')
        mqttOut.should.have.property('brokerConn').and.be.type('object')

        mqttOut.brokerConn.should.equal(mqttIn.brokerConn) // should be the same broker connection
        const mqttBroker = mqttOut.brokerConn
        clearInterval(mqttBroker.linkMonitorInterval) // clear the link monitor interval so the test can exit
    })

    it('should publish with QoS 1 and retain false by default', async function () {
        this.timeout = 2000
        const { flow } = buildBasicMQTTSendRecvFlow({ id: 'mqtt.in', topic: 'in_topic' }, { id: 'mqtt.out', topic: 'out_topic' })
        await helper.load(mqttNodes, flow)

        const mqttOut = helper.getNode('mqtt.out')
        const mqttBroker = mqttOut.brokerConn

        const testMsg = {
            topic: 'out_topic',
            payload: 'test message'
        }

        // fake state to allow client.publish to work
        mqttBroker.connected = true
        const originalClient = mqttBroker.client
        mqttBroker.client = {
            publish: sinon.stub(),
            end: sinon.stub()
        }
        mqttOut.receive(testMsg)
        mqttBroker.client.publish.calledOnce.should.be.true()
        mqttBroker.client.publish.getCall(0).args[0].should.equal('out_topic')
        mqttBroker.client.publish.getCall(0).args[1].should.equal('test message')
        mqttBroker.client.publish.getCall(0).args[2].should.have.property('qos', 1) // default QoS 1
        mqttBroker.client.publish.getCall(0).args[2].should.have.property('retain', false) // default retain false
        mqttBroker.client = originalClient
        clearInterval(mqttBroker.linkMonitorInterval) // clear the link monitor interval so the test can exit
    })

    it('should publish with specified QoS and retain values', async function () {
        this.timeout = 2000
        const { flow } = buildBasicMQTTSendRecvFlow({ id: 'mqtt.in', topic: 'in_topic' }, { id: 'mqtt.out', topic: '' })
        await helper.load(mqttNodes, flow)

        const mqttOut = helper.getNode('mqtt.out')
        const mqttBroker = mqttOut.brokerConn

        const testMsg = {
            topic: 'out_topic2',
            payload: 'test message2',
            qos: 2,
            retain: true
        }

        // fake state to allow client.publish to work
        mqttBroker.connected = true
        const originalClient = mqttBroker.client
        mqttBroker.client = {
            publish: sinon.stub(),
            end: sinon.stub()
        }
        mqttOut.receive(testMsg)
        mqttBroker.client.publish.calledOnce.should.be.true()
        mqttBroker.client.publish.getCall(0).args[0].should.equal('out_topic2')
        mqttBroker.client.publish.getCall(0).args[1].should.equal('test message2')
        mqttBroker.client.publish.getCall(0).args[2].should.have.property('qos', 2) // non default QoS 2
        mqttBroker.client.publish.getCall(0).args[2].should.have.property('retain', true) // non default retain true
        mqttBroker.client = originalClient
        clearInterval(mqttBroker.linkMonitorInterval) // clear the link monitor interval so the test can exit
    })

    if (skipTests) {
        it('skipping MQTT tests. Set env var "NR_MQTT_TESTS=true" to enable. Requires a v5 capable broker running on localhost:1883.', function (done) {
            done()
        })
    }
    // Conditional test runner (only run if skipTests=false)
    function itConditional (title, test) {
        return !skipTests ? it(title, test) : it.skip(title, test)
    }
    itConditional.skip = it.skip
    // eslint-disable-next-line no-only-tests/no-only-tests
    itConditional.only = it.only

    // #region ################### BASIC TESTS ################### #//

    itConditional('basic send and receive tests', function (done) {
        if (skipTests) { return this.skip() }
        this.timeout = 2000
        const options = {}
        options.sendMsg = {
            topic: nextTopic(),
            payload: 'hello',
            qos: 0
        }
        options.expectMsg = Object.assign({}, options.sendMsg)
        testSendRecv({}, { datatype: 'auto', topicType: 'static' }, {}, options, { done })
    })
    // Prior to V3, "auto" mode would only parse to string or buffer.
    itConditional('should send JSON and receive string (auto mode)', function (done) {
        if (skipTests) { return this.skip() }
        this.timeout = 2000
        const options = {}
        options.sendMsg = {
            topic: nextTopic(),
            payload: '{"prop":"value1", "num":1}',
            qos: 1
        }
        options.expectMsg = Object.assign({}, options.sendMsg)
        testSendRecv({}, { datatype: 'auto', topicType: 'static' }, {}, options, { done })
    })
    // In V3, "auto" mode should try to parse JSON, then string and fall back to buffer
    itConditional('should send JSON and receive object (auto-detect mode)', function (done) {
        if (skipTests) { return this.skip() }
        this.timeout = 2000
        const options = {}
        options.sendMsg = {
            topic: nextTopic(),
            payload: '{"prop":"value1", "num":1}',
            qos: 1
        }
        options.expectMsg = Object.assign({}, options.sendMsg)
        options.expectMsg.payload = JSON.parse(options.sendMsg.payload)
        testSendRecv({}, { datatype: 'auto-detect', topicType: 'static' }, {}, options, { done })
    })
    itConditional('should send invalid JSON and receive string (auto mode)', function (done) {
        if (skipTests) { return this.skip() }
        this.timeout = 2000
        const options = {}
        options.sendMsg = {
            topic: nextTopic(),
            payload: '{prop:"value3", "num":3}'// send invalid JSON ...
        }
        options.expectMsg = Object.assign({}, options.sendMsg)// expect same payload
        testSendRecv({}, { datatype: 'auto', topicType: 'static' }, {}, options, { done })
    })
    itConditional('should send invalid JSON and receive string (auto-detect mode)', function (done) {
        if (skipTests) { return this.skip() }
        this.timeout = 2000
        const options = {}
        options.sendMsg = {
            topic: nextTopic(),
            payload: '{prop:"value3", "num":3}'// send invalid JSON ...
        }
        options.expectMsg = Object.assign({}, options.sendMsg)// expect same payload
        testSendRecv({}, { datatype: 'auto-detect', topicType: 'static' }, {}, options, { done })
    })

    itConditional('should send JSON and receive string (utf8 mode)', function (done) {
        if (skipTests) { return this.skip() }
        this.timeout = 2000
        const options = {}
        options.sendMsg = {
            topic: nextTopic(),
            payload: '{"prop":"value2", "num":2}',
            qos: 2
        }
        options.expectMsg = Object.assign({}, options.sendMsg)
        testSendRecv({}, { datatype: 'utf8', topicType: 'static' }, {}, options, { done })
    })
    itConditional('should send JSON and receive Object (json mode)', function (done) {
        if (skipTests) { return this.skip() }
        this.timeout = 2000
        const options = {}
        options.sendMsg = {
            topic: nextTopic(),
            payload: '{"prop":"value3", "num":3}'// send a string ...
        }
        options.expectMsg = Object.assign({}, options.sendMsg, { payload: { prop: 'value3', num: 3 } })// expect an object
        testSendRecv({}, { datatype: 'json', topicType: 'static' }, {}, options, { done })
    })
    itConditional('should send invalid JSON and raise error (json mode)', function (done) {
        if (skipTests) { return this.skip() }
        this.timeout = 2000
        const options = {}
        options.sendMsg = {
            topic: nextTopic(),
            payload: '{prop:"value3", "num":3}' // send invalid JSON ...
        }
        const hooks = { done: null, beforeLoad: null, afterLoad: null, afterConnect: null }
        hooks.afterLoad = (helperNode, mqttBroker, mqttIn, mqttOut) => {
            helperNode.on('input', function (msg) {
                try {
                    msg.should.have.a.property('error').type('object')
                    msg.error.should.have.a.property('source').type('object')
                    msg.error.source.should.have.a.property('id', mqttIn.id)
                    done()
                } catch (err) {
                    done(err)
                }
            })
            return true // handled
        }
        testSendRecv({}, { datatype: 'json', topicType: 'static' }, {}, options, hooks)
    })
    itConditional('should send String and receive Buffer (buffer mode)', function (done) {
        if (skipTests) { return this.skip() }
        this.timeout = 2000
        const options = {}
        options.sendMsg = {
            topic: nextTopic(),
            payload: 'a b c' // send string ...
        }
        options.expectMsg = Object.assign({}, options.sendMsg, { payload: Buffer.from(options.sendMsg.payload) })// expect Buffer.from(msg.payload)
        testSendRecv({}, { datatype: 'buffer', topicType: 'static' }, {}, options, { done })
    })
    itConditional('should send utf8 Buffer and receive String (auto mode)', function (done) {
        if (skipTests) { return this.skip() }
        this.timeout = 2000
        const options = {}
        options.sendMsg = {
            topic: nextTopic(),
            payload: Buffer.from([0x78, 0x20, 0x79, 0x20, 0x7a]) // "x y z"
        }
        options.expectMsg = Object.assign({}, options.sendMsg, { payload: 'x y z' })// set expected payload to "x y z"
        testSendRecv({}, { datatype: 'auto', topicType: 'static' }, {}, options, { done })
    })
    itConditional('should send non utf8 Buffer and receive Buffer (auto mode)', function (done) {
        if (skipTests) { return this.skip() }
        this.timeout = 2000
        const options = {}
        const hooks = { done, beforeLoad: null, afterLoad: null, afterConnect: null }
        options.sendMsg = {
            topic: nextTopic(),
            payload: Buffer.from([0xC0, 0xC1, 0xF5, 0xF6, 0xF7, 0xF8, 0xF9, 0xFA, 0xFB, 0xFC, 0xFD, 0xFE, 0xFF]) // non valid UTF8
        }
        options.expectMsg = Object.assign({}, options.sendMsg, { payload: Buffer.from([0xC0, 0xC1, 0xF5, 0xF6, 0xF7, 0xF8, 0xF9, 0xFA, 0xFB, 0xFC, 0xFD, 0xFE, 0xFF]) })
        testSendRecv({}, { datatype: 'auto', topicType: 'static' }, {}, options, hooks)
    })
    itConditional('should send/receive all v5 flags and settings', function (done) {
        if (skipTests) { return this.skip() }
        this.timeout = 2000
        const t = nextTopic()
        const options = {}
        const hooks = { done, beforeLoad: null, afterLoad: null, afterConnect: null }
        options.sendMsg = {
            topic: t + '/command',
            payload: Buffer.from('{"version":"v5"}'),
            qos: 1,
            retain: true,
            responseTopic: t + '/response',
            userProperties: { prop1: 'val1' },
            contentType: 'text/plain',
            correlationData: Buffer.from([1, 2, 3]),
            payloadFormatIndicator: true,
            messageExpiryInterval: 2000
        }
        options.expectMsg = Object.assign({}, options.sendMsg)
        options.expectMsg.payload = options.expectMsg.payload.toString() // auto mode + payloadFormatIndicator + contentType: "text/plain" should make a string
        delete options.expectMsg.payloadFormatIndicator // Seems mqtt.js only publishes payloadFormatIndicator the will msg
        const inOptions = {
            datatype: 'auto',
            topicType: 'static',
            qos: 1,
            nl: false,
            rap: true,
            rh: 1
        }
        testSendRecv({ protocolVersion: 5 }, inOptions, {}, options, hooks)
    })
    itConditional('should send regular string with v5 media type "text/plain" and receive a string (auto mode)', function (done) {
        if (skipTests) { return this.skip() }
        this.timeout = 2000
        const options = {}
        const hooks = { done, beforeLoad: null, afterLoad: null, afterConnect: null }
        options.sendMsg = {
            topic: nextTopic(), payload: 'abc', contentType: 'text/plain'
        }
        options.expectMsg = Object.assign({}, options.sendMsg)
        testSendRecv({ protocolVersion: 5 }, { datatype: 'auto', topicType: 'static' }, {}, options, hooks)
    })
    itConditional('should send JSON with v5 media type "text/plain" and receive a string (auto mode)', function (done) {
        if (skipTests) { return this.skip() }
        this.timeout = 2000
        const options = {}
        const hooks = { done, beforeLoad: null, afterLoad: null, afterConnect: null }
        options.sendMsg = {
            topic: nextTopic(), payload: '{"prop":"val"}', contentType: 'text/plain'
        }
        options.expectMsg = Object.assign({}, options.sendMsg)
        testSendRecv({ protocolVersion: 5 }, { datatype: 'auto', topicType: 'static' }, {}, options, hooks)
    })
    itConditional('should send JSON with v5 media type "text/plain" and receive a string (auto-detect mode)', function (done) {
        if (skipTests) { return this.skip() }
        this.timeout = 2000
        const options = {}
        const hooks = { done, beforeLoad: null, afterLoad: null, afterConnect: null }
        options.sendMsg = {
            topic: nextTopic(), payload: '{"prop":"val"}', contentType: 'text/plain'
        }
        options.expectMsg = Object.assign({}, options.sendMsg)
        testSendRecv({ protocolVersion: 5 }, { datatype: 'auto-detect', topicType: 'static' }, {}, options, hooks)
    })
    itConditional('should send JSON with v5 media type "application/json" and receive an object (auto-detect mode)', function (done) {
        if (skipTests) { return this.skip() }
        this.timeout = 2000
        const options = {}
        const hooks = { done, beforeLoad: null, afterLoad: null, afterConnect: null }
        options.sendMsg = {
            topic: nextTopic(), payload: '{"prop":"val"}', contentType: 'application/json'
        }
        options.expectMsg = Object.assign({}, options.sendMsg, { payload: JSON.parse(options.sendMsg.payload) })
        testSendRecv({ protocolVersion: 5 }, { datatype: 'auto-detect', topicType: 'static' }, {}, options, hooks)
    })
    itConditional('should send invalid JSON with v5 media type "application/json" and raise an error (auto mode)', function (done) {
        if (skipTests) { return this.skip() }
        this.timeout = 2000
        const options = {}
        options.sendMsg = {
            topic: nextTopic(),
            payload: '{prop:"value3", "num":3}',
            contentType: 'application/json' // send invalid JSON ...
        }
        const hooks = { done: null, beforeLoad: null, afterLoad: null, afterConnect: null }
        hooks.afterLoad = (helperNode, mqttBroker, mqttIn, mqttOut) => {
            helperNode.on('input', function (msg) {
                try {
                    msg.should.have.a.property('error').type('object')
                    msg.error.should.have.a.property('source').type('object')
                    msg.error.source.should.have.a.property('id', mqttIn.id)
                    done()
                } catch (err) {
                    done(err)
                }
            })
            return true // handled
        }
        testSendRecv({ protocolVersion: 5 }, { datatype: 'auto', topicType: 'static' }, {}, options, hooks)
    })

    itConditional('should send buffer with v5 media type "application/json" and receive an object (auto-detect mode)', function (done) {
        if (skipTests) { return this.skip() }
        this.timeout = 2000
        const options = {}
        const hooks = { done, beforeLoad: null, afterLoad: null, afterConnect: null }
        options.sendMsg = {
            topic: nextTopic(), payload: Buffer.from([0x7b, 0x22, 0x70, 0x72, 0x6f, 0x70, 0x22, 0x3a, 0x22, 0x76, 0x61, 0x6c, 0x22, 0x7d]), contentType: 'application/json'
        }
        options.expectMsg = Object.assign({}, options.sendMsg, { payload: { prop: 'val' } })
        testSendRecv({ protocolVersion: 5 }, { datatype: 'auto-detect', topicType: 'static' }, {}, options, hooks)
    })
    itConditional('should send buffer with v5 media type "text/plain" and receive a string (auto mode)', function (done) {
        if (skipTests) { return this.skip() }
        this.timeout = 2000
        const options = {}
        const hooks = { done, beforeLoad: null, afterLoad: null, afterConnect: null }
        options.sendMsg = {
            topic: nextTopic(), payload: Buffer.from([0x7b, 0x22, 0x70, 0x72, 0x6f, 0x70, 0x22, 0x3a, 0x22, 0x76, 0x61, 0x6c, 0x22, 0x7d]), contentType: 'text/plain'
        }
        options.expectMsg = Object.assign({}, options.sendMsg, { payload: '{"prop":"val"}' })
        testSendRecv({ protocolVersion: 5 }, { datatype: 'auto', topicType: 'static' }, {}, options, hooks)
    })
    itConditional('should send buffer with v5 media type "application/zip" and receive a buffer (auto mode)', function (done) {
        if (skipTests) { return this.skip() }
        this.timeout = 2000
        const options = {}
        const hooks = { done, beforeLoad: null, afterLoad: null, afterConnect: null }
        options.sendMsg = {
            topic: nextTopic(), payload: Buffer.from([0x7b, 0x22, 0x70, 0x72, 0x6f, 0x70, 0x22, 0x3a, 0x22, 0x76, 0x61, 0x6c, 0x22, 0x7d]), contentType: 'application/zip'
        }
        options.expectMsg = Object.assign({}, options.sendMsg, { payload: Buffer.from([0x7b, 0x22, 0x70, 0x72, 0x6f, 0x70, 0x22, 0x3a, 0x22, 0x76, 0x61, 0x6c, 0x22, 0x7d]) })
        testSendRecv({ protocolVersion: 5 }, { datatype: 'auto', topicType: 'static' }, {}, options, hooks)
    })

    itConditional('should subscribe dynamically via action', function (done) {
        if (skipTests) { return this.skip() }
        this.timeout = 2000
        const options = {}
        const hooks = { done, beforeLoad: null, afterLoad: null, afterConnect: null }
        options.sendMsg = {
            topic: nextTopic(), payload: 'abc'
        }
        options.expectMsg = Object.assign({}, options.sendMsg)
        testSendRecv({ protocolVersion: 5 }, { datatype: 'utf8', topicType: 'dynamic' }, {}, options, hooks)
    })
    // #endregion  BASIC TESTS

    // #region ################### ADVANCED TESTS ################### #//
    // next test is skipped because broker options are not settible for ff-mqtt nodes (always auto connects)
    itConditional.skip('should connect via "connect" action', function (done) {
        if (skipTests) { return this.skip() }
        this.timeout = 2000
        const options = {}
        const hooks = { done: null, beforeLoad: null, afterLoad: null, afterConnect: null }
        hooks.afterLoad = (helperNode, mqttBroker, mqttIn, mqttOut) => {
            mqttBroker.should.have.property('autoConnect', false)
            mqttBroker.should.have.property('connecting', false)// should not attempt to connect (autoConnect:false)
            mqttIn.receive({ action: 'connect' }) // now request connect action
            return true // handled
        }
        hooks.afterConnect = (helperNode, mqttBroker, mqttIn, mqttOut) => {
            done()// if we got here, it connected :)
            return true
        }
        testSendRecv({ protocolVersion: 5, autoConnect: false }, { datatype: 'utf8', topicType: 'dynamic' }, {}, options, hooks)
    })
    itConditional('should disconnect via "disconnect" action', function (done) {
        if (skipTests) { return this.skip() }
        this.timeout = 2000
        const options = {}
        const hooks = { beforeLoad: null, afterLoad: null, afterConnect: null }
        hooks.beforeLoad = (flow) => { // add a status node pointed at MQTT Out node (to watch for connection status change)
            flow.push({ id: 'status.node', type: 'status', name: 'status_node', scope: ['mqtt.out'], wires: [['helper.node']] })// add status node to watch mqtt_out
        }
        hooks.afterLoad = (helperNode, mqttBroker, mqttIn, mqttOut) => {
            mqttBroker.should.have.property('autoConnect', true)
            mqttBroker.should.have.property('connecting', true)// should be trying to connect (autoConnect:true)
            return true // handled
        }
        hooks.afterConnect = (helperNode, mqttBroker, mqttIn, mqttOut) => {
            // connected - now add the "on" handler then send "disconnect" action
            helperNode.on('input', function (msg) {
                try {
                    msg.should.have.property('status')
                    msg.status.should.have.property('text')
                    msg.status.text.should.containEql('disconnect')
                    done() // it disconnected - yey!
                } catch (error) {
                    done(error)
                }
            })
            mqttOut.receive({ action: 'disconnect' })
            return true // handed
        }
        testSendRecv({ protocolVersion: 5 }, null, {}, options, hooks)
    })
    // next test is skipped because broker options are not settible for ff-mqtt nodes (always auto connects)
    itConditional.skip('should publish birth message', function (done) {
        if (skipTests) { return this.skip() }
        this.timeout = 2000
        const baseTopic = nextTopic()
        const brokerOptions = {
            autoConnect: false,
            protocolVersion: 4,
            birthTopic: baseTopic + '/birth',
            birthPayload: 'broker birth',
            birthQos: 2
        }
        const expectMsg = {
            topic: brokerOptions.birthTopic,
            payload: brokerOptions.birthPayload,
            qos: brokerOptions.birthQos
        }
        const options = { }
        const hooks = { }
        hooks.afterLoad = (helperNode, mqttBroker, mqttIn, mqttOut) => {
            helperNode.on('input', function (msg) {
                try {
                    compareMsgToExpected(msg, expectMsg)
                    done()
                } catch (error) {
                    done(error)
                }
            })
            mqttIn.receive({ action: 'connect' }) // now request connect action
            return true // handled
        }
        testSendRecv(brokerOptions, { topic: brokerOptions.birthTopic }, {}, options, hooks)
    })
    // next test is skipped because broker options are not settible for ff-mqtt nodes (always auto connects)
    itConditional.skip('should safely discard bad birth topic', function (done) {
        if (skipTests) { return this.skip() }
        this.timeout = 2000
        const baseTopic = nextTopic()
        const brokerOptions = {
            protocolVersion: 4,
            birthTopic: baseTopic + '#', // a publish topic should never have a wildcard
            birthPayload: 'broker connected',
            birthQos: 2
        }
        const options = {}
        const hooks = { done: null, beforeLoad: null, afterLoad: null, afterConnect: null }
        hooks.afterLoad = (helperNode, mqttBroker, mqttIn, mqttOut) => {
            helperNode.on('input', function (msg) {
                try {
                    msg.should.have.a.property('error').type('object')
                    msg.error.should.have.a.property('source').type('object')
                    msg.error.source.should.have.a.property('id', mqttIn.id)
                    done()
                } catch (err) {
                    done(err)
                }
            })
            return true // handled
        }
        options.expectMsg = null
        try {
            testSendRecv(brokerOptions, { topic: brokerOptions.birthTopic }, {}, options, hooks)
            done()
        } catch (error) {
            done(error)
        }
    })
    // next test is skipped because broker options are not settible for ff-mqtt nodes (always auto connects)
    itConditional.skip('should publish close message', function (done) {
        if (skipTests) { return this.skip() }
        this.timeout = 2000
        const baseTopic = nextTopic()
        const broker1Options = { id: 'mqtt.broker1' }// Broker 1 - stays connected to receive the close message
        const broker2Options = { id: 'mqtt.broker2', closeTopic: baseTopic + '/close', closePayload: '{"msg":"close"}', closeQos: 1 }// Broker 2 - connects to same broker but has a LWT message.
        const { flow } = buildBasicMQTTSendRecvFlow(broker1Options, { broker: broker1Options.id, topic: broker2Options.closeTopic, datatype: 'json' }, { broker: broker2Options.id })
        flow.push(buildMQTTBrokerNode(broker2Options.id, broker2Options.name, BROKER_HOST, BROKER_PORT, broker2Options)) // add second broker
        helper.load(mqttNodes, flow, function () {
            const helperNode = helper.getNode('helper.node')
            const mqttOut = helper.getNode('mqtt.out')
            const mqttBroker1 = helper.getNode('mqtt.broker1')
            const mqttBroker2 = helper.getNode('mqtt.broker2')
            waitBrokerConnect([mqttBroker1, mqttBroker2])
                .then(() => {
                // connected - add the on handler and call to disconnect
                    helperNode.on('input', function (msg) {
                        try {
                            msg.should.have.property('topic', broker2Options.closeTopic)
                            msg.should.have.property('payload', JSON.parse(broker2Options.closePayload))
                            msg.should.have.property('qos', broker2Options.closeQos)
                            done()
                        } catch (error) {
                            done(error)
                        }
                    })
                    mqttOut.receive({ action: 'disconnect' })// close broker2
                })
                .catch(done)
        })
    })
    // next test is skipped because broker options are not settible for ff-mqtt nodes (always auto connects)
    itConditional.skip('should publish will message', function (done) {
        if (skipTests) { return this.skip() }
        this.timeout = 2000
        const baseTopic = nextTopic()
        const broker1Options = { id: 'mqtt.broker1' }// Broker 1 - stays connected to receive the will message
        const broker2Options = { id: 'mqtt.broker2', willTopic: baseTopic + '/will', willPayload: '{"msg":"will"}', willQos: 2 }// Broker 2 - connects to same broker but has a LWT message.
        const { flow } = buildBasicMQTTSendRecvFlow(broker1Options, { broker: broker1Options.id, topic: broker2Options.willTopic, datatype: 'utf8' }, { broker: broker2Options.id })
        flow.push(buildMQTTBrokerNode(broker2Options.id, broker2Options.name, BROKER_HOST, BROKER_PORT, broker2Options)) // add second broker

        helper.load(mqttNodes, flow, function () {
            const helperNode = helper.getNode('helper.node')
            const mqttBroker1 = helper.getNode('mqtt.broker1')
            const mqttBroker2 = helper.getNode('mqtt.broker2')
            waitBrokerConnect([mqttBroker1, mqttBroker2])
                .then(() => {
                // connected - add the on handler and call to disconnect
                    helperNode.on('input', function (msg) {
                        try {
                            msg.should.have.property('topic', broker2Options.willTopic)
                            msg.should.have.property('payload', broker2Options.willPayload)
                            msg.should.have.property('qos', broker2Options.willQos)
                            done()
                        } catch (error) {
                            done(error)
                        }
                    })
                    mqttBroker2.client.end(true) // force closure
                })
                .catch(done)
        })
    })
    // next test is skipped because broker options are not settible for ff-mqtt nodes (always auto connects)
    itConditional.skip('should publish will message with V5 properties', function (done) {
        if (skipTests) { return this.skip() }
        // return this.skip(); //Issue receiving v5 props on will msg. Issue raised here: https://github.com/mqttjs/MQTT.js/issues/1455
        this.timeout = 2000
        const baseTopic = nextTopic()
        // Broker 1 - stays connected to receive the will message when broker 2 is killed
        const broker1Options = { id: 'mqtt.broker1', name: 'mqtt_broker1', protocolVersion: 5, datatype: 'utf8' }
        // Broker 2 - connects to same broker but has a LWT message. Broker 2 gets killed shortly after connection so that the will message is sent from broker
        const broker2Options = {
            id: 'mqtt.broker2',
            name: 'mqtt_broker2',
            protocolVersion: 5,
            willTopic: baseTopic + '/will',
            willPayload: '{"msg":"will"}',
            willQos: 2,
            willMsg: {
                contentType: 'application/json',
                userProps: { will: 'value' },
                respTopic: baseTopic + '/resp',
                correl: Buffer.from('abc'),
                expiry: 2000,
                payloadFormatIndicator: true
            }
        }
        const expectMsg = {
            topic: broker2Options.willTopic,
            payload: broker2Options.willPayload,
            qos: broker2Options.willQos,
            contentType: broker2Options.willMsg.contentType,
            userProperties: broker2Options.willMsg.userProps,
            responseTopic: broker2Options.willMsg.respTopic,
            correlationData: broker2Options.willMsg.correl,
            messageExpiryInterval: broker2Options.willMsg.expiry
            // payloadFormatIndicator: broker2Options.willMsg.payloadFormatIndicator,
        }
        const { flow, nodes } = buildBasicMQTTSendRecvFlow(broker1Options, { broker: broker1Options.id, topic: broker2Options.willTopic, datatype: 'utf8' }, { broker: broker2Options.id })
        flow.push(buildMQTTBrokerNode(broker2Options.id, broker2Options.name, nodes.mqtt_broker1.broker, nodes.mqtt_broker1.port, broker2Options)) // add second broker with will msg set
        helper.load(mqttNodes, flow, function () {
            const helperNode = helper.getNode('helper.node')
            const mqttBroker1 = helper.getNode('mqtt.broker1')
            const mqttBroker2 = helper.getNode('mqtt.broker2')
            waitBrokerConnect([mqttBroker1, mqttBroker2])
                .then(() => {
                // connected - add the on handler and call to disconnect
                    helperNode.on('input', function (msg) {
                        try {
                            compareMsgToExpected(msg, expectMsg)
                            done()
                        } catch (error) {
                            done(error)
                        }
                    })
                    mqttBroker2.client.end(true) // force closure
                })
                .catch(done)
        })
    })
    // #endregion  ADVANCED TESTS
})

// #region ################### HELPERS ################### #//

/**
 * A basic unit test that builds a flow containing 1 broker, 1 mqtt-in, one mqtt-out and a helper.
 *  It performs the following steps: builds flow, loads flow, waits for connection, sends `sendMsg`,
 *  waits for msg then compares `sendMsg` to `expectMsg`, and finally calls `done`
 * @param {object} brokerOptions anything that can be set in an MQTTBrokerNode (e.g. id, name, url, broker, server, port, protocolVersion, ...)
 * @param {object} inNodeOptions anything that can be set in an MQTTInNode (e.g. id, name, broker, topic, rh, nl, rap, ... )
 * @param {object} outNodeOptions anything that can be set in an MQTTOutNode (e.g. id, name, broker, ...)
 * @param {object} options an object for passing in test properties like `sendMsg` and `expectMsg`
 * @param {object} hooks an object containing hook functions...
 *   * [fn] `done()` - the tests done function. If excluded, an error will be thrown upon test error
 *   * [fn] `beforeLoad(flow)` - provides opportunity to adjust the flow JSON before loading into runtime
 *   * [fn] `afterLoad(helperNode, mqttBroker, mqttIn, mqttOut)` - called before connection attempt
 *   * [fn] `afterConnect(helperNode, mqttBroker, mqttIn, mqttOut)` - called before connection attempt
 */
function testSendRecv (brokerOptions, inNodeOptions, outNodeOptions, options, hooks) {
    options = options || {}
    brokerOptions = brokerOptions || {}
    inNodeOptions = inNodeOptions || {}
    outNodeOptions = outNodeOptions || {}
    const sendMsg = options.sendMsg || {}
    sendMsg.topic = sendMsg.topic || nextTopic()
    const expectMsg = options.expectMsg || Object.assign({}, sendMsg)
    expectMsg.payload = inNodeOptions.payload === undefined ? expectMsg.payload : inNodeOptions.payload
    if (inNodeOptions.topicType !== 'dynamic') {
        inNodeOptions.topic = inNodeOptions.topic || sendMsg.topic
    }

    const { flow, nodes } = buildBasicMQTTSendRecvFlow(inNodeOptions, outNodeOptions)
    if (hooks.beforeLoad) { hooks.beforeLoad(flow) }
    helper.load(mqttNodes, flow, function () {
        let finished = false
        try {
            const helperNode = helper.getNode('helper.node')
            const mqttIn = helper.getNode(nodes.mqtt_in.id)
            const mqttOut = helper.getNode(nodes.mqtt_out.id)
            const mqttBroker = mqttIn.brokerConn || mqttOut.brokerConn
            let afterLoadHandled = false
            if (hooks.afterLoad) {
                afterLoadHandled = hooks.afterLoad(helperNode, mqttBroker, mqttIn, mqttOut)
            }
            if (!afterLoadHandled) {
                helperNode.on('input', function (msg) {
                    finished = true
                    try {
                        compareMsgToExpected(msg, expectMsg)
                        if (hooks.done) { hooks.done() }
                    } catch (err) {
                        if (hooks.done) { hooks.done(err) } else { throw err }
                    }
                })
            }
            waitBrokerConnect(mqttBroker)
                .then(() => {
                // finally, connected!
                    if (hooks.afterConnect) {
                        const handled = hooks.afterConnect(helperNode, mqttBroker, mqttIn, mqttOut)
                        if (handled) { return }
                    }
                    if (sendMsg.topic) {
                        if (mqttIn.isDynamic) {
                            mqttIn.receive({ action: 'subscribe', topic: sendMsg.topic })
                        }
                        mqttOut.receive(sendMsg)
                    }
                })
                .catch((e) => {
                    if (finished) { return }
                    if (hooks.done) { hooks.done(e) } else { throw e }
                })
        } catch (err) {
            if (finished) { return }
            if (hooks.done) { hooks.done(err) } else { throw err }
        }
    })
}

/**
 * Builds a flow containing 2 parts.
 * * 1: MQTT Out node (with broker configured).
 * * 2: MQTT In node (with broker configured) --> helper node `id:helper.node`
*/
function buildBasicMQTTSendRecvFlow (inOptions, outOptions) {
    const inNode = buildMQTTInNode(inOptions.id, inOptions.name, inOptions.topic, inOptions, ['helper.node'])
    const outNode = buildMQTTOutNode(outOptions.id, outOptions.name, outOptions.topic, outOptions)
    const helper = buildNode('helper', 'helper.node', 'helper_node', {})
    const catchNode = buildNode('catch', 'catch.node', 'catch_node', { scope: ['mqtt.in'] }, ['helper.node'])
    return {
        nodes: {
            [inNode.name]: inNode,
            [outNode.name]: outNode,
            [helper.name]: helper,
            [catchNode.name]: catchNode
        },
        flow: [inNode, outNode, helper, catchNode]
    }
}

function buildMQTTBrokerNode (id, name, brokerHost, brokerPort, options) {
    // url,broker,port,clientid,autoConnect,usetls,usews,verifyservercert,compatmode,protocolVersion,keepalive,
    // cleansession,sessionExpiry,topicAliasMaximum,maximumPacketSize,receiveMaximum,userProperties,userPropertiesType,autoUnsubscribe
    options = options || {}
    const node = buildNode('mqtt-broker', id || 'mqtt.broker', name || 'mqtt_broker', options)
    node.url = options.url
    node.broker = brokerHost || options.broker || BROKER_HOST
    node.port = brokerPort || options.port || BROKER_PORT
    node.clientid = options.clientid || ''
    node.cleansession = String(options.cleansession) !== 'false'
    node.autoUnsubscribe = String(options.autoUnsubscribe) !== 'false'
    node.autoConnect = String(options.autoConnect) !== 'false'
    node.sessionExpiry = options.sessionExpiry ? options.sessionExpiry : undefined

    if (options.birthTopic) {
        node.birthTopic = options.birthTopic
        node.birthQos = options.birthQos || '0'
        node.birthPayload = options.birthPayload || ''
    }
    if (options.closeTopic) {
        node.closeTopic = options.closeTopic
        node.closeQos = options.closeQos || '0'
        node.closePayload = options.closePayload || ''
    }
    if (options.willTopic) {
        node.willTopic = options.willTopic
        node.willQos = options.willQos || '0'
        node.willPayload = options.willPayload || ''
    }
    updateNodeOptions(options, node)
    return node
}

function buildMQTTInNode (id, name, topic, options, wires) {
    // { "id": "mqtt.in", "type": "mqtt in", "name": "mqtt_in", "topic": "test/in", "qos": "2", "datatype": "auto", "broker": "mqtt.broker", "nl": false, "rap": true, "rh": 0, "inputs": 0, "wires": [["mqtt.out"]] }
    options = options || {}
    const node = buildNode('ff-mqtt-in', id || 'mqtt.in', name || 'mqtt_in', options)
    node.topic = topic || ''
    node.topicType = options.topicType === 'dynamic' ? 'dynamic' : 'static'
    node.inputs = options.topicType === 'dynamic' ? 1 : 0
    updateNodeOptions(node, options, wires)
    return node
}

function buildMQTTOutNode (id, name, topic, options) {
    // { "id": "mqtt.out", "type": "mqtt out", "name": "mqtt_out", "topic": "test/out", "qos": "", "retain": "", "respTopic": "", "contentType": "", "userProps": "", "correl": "", "expiry": "", "broker": brokerId, "wires": [] },
    options = options || {}
    options.broker = options.broker || 'mqtt.broker'
    const node = buildNode('ff-mqtt-out', id || 'mqtt.out', name || 'mqtt_out', options)
    node.topic = topic || ''
    updateNodeOptions(node, options, null)
    return node
}

function buildNode (type, id, name, options, wires) {
    // { "id": "mqtt.in", "type": "mqtt in", "name": "mqtt_in", "topic": "test/in", "qos": "2", "datatype": "auto", "broker": "mqtt.broker", "nl": false, "rap": true, "rh": 0, "inputs": 0, "wires": [["mqtt.out"]] }
    options = options || {}
    const node = {
        id: id || (type.replace(/[\W]/g, '.')),
        type,
        name: name || (type.replace(/[\W]/g, '_')),
        wires: []
    }
    if (node.id.indexOf('.') === -1) { node.id += '.node' }
    updateNodeOptions(node, options, wires)
    return node
}

function updateNodeOptions (node, options, wires) {
    const keys = Object.keys(options)
    for (let index = 0; index < keys.length; index++) {
        const key = keys[index]
        const val = options[key]
        if (node[key] === undefined) {
            node[key] = val
        }
    }
    if (wires && Array.isArray(wires)) {
        node.wires[0] = [...wires]
    }
}

function compareMsgToExpected (msg, expectMsg) {
    msg.should.have.property('topic', expectMsg.topic)
    msg.should.have.property('payload', expectMsg.payload)
    if (hasProperty(expectMsg, 'retain')) { msg.retain.should.eql(expectMsg.retain) }
    if (hasProperty(expectMsg, 'qos')) {
        msg.qos.should.eql(expectMsg.qos)
    } else {
        msg.qos.should.eql(0)
    }
    if (hasProperty(expectMsg, 'userProperties')) { msg.should.have.property('userProperties', expectMsg.userProperties) }
    if (hasProperty(expectMsg, 'contentType')) { msg.should.have.property('contentType', expectMsg.contentType) }
    if (hasProperty(expectMsg, 'correlationData')) { msg.should.have.property('correlationData', expectMsg.correlationData) }
    if (hasProperty(expectMsg, 'responseTopic')) { msg.should.have.property('responseTopic', expectMsg.responseTopic) }
    if (hasProperty(expectMsg, 'payloadFormatIndicator')) { msg.should.have.property('payloadFormatIndicator', expectMsg.payloadFormatIndicator) }
    if (hasProperty(expectMsg, 'messageExpiryInterval')) { msg.should.have.property('messageExpiryInterval', expectMsg.messageExpiryInterval) }
}

function waitBrokerConnect (broker, timeLimit) {
    const waitConnected = (broker, timeLimit) => {
        const brokers = Array.isArray(broker) ? broker : [broker]
        timeLimit = timeLimit || 1000
        return new Promise((resolve, reject) => {
            let timer; let resolved = false
            timer = wait()
            function wait () {
                if (brokers.every(e => e.connected === true)) {
                    resolved = true
                    clearTimeout(timer)
                    resolve()
                } else {
                    timeLimit = timeLimit - 15
                    if (timeLimit <= 0) {
                        if (!resolved) {
                            // eslint-disable-next-line prefer-promise-reject-errors
                            reject('Timeout waiting broker connect')
                        }
                    }
                    timer = setTimeout(wait, 15)
                    return timer
                }
            }
        })
    }
    return waitConnected(broker, timeLimit)
}

function hasProperty (obj, propName) {
    return Object.prototype.hasOwnProperty.call(obj, propName)
}

const baseTopic = 'nr' + Date.now().toString() + '/'
let topicNo = 0
function nextTopic (topic) {
    topicNo++
    if (!topic) { topic = 'unittest' }
    if (topic.startsWith('/')) { topic = topic.substring(1) }
    if (topic.startsWith(baseTopic)) { return topic + String(topicNo) }
    return (baseTopic + topic + String(topicNo))
}

// #endregion HELPERS
