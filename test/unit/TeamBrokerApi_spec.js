'use strict'
const net = require('net')
const should = require('should')
const sinon = require('sinon')
const Got = require('got').default
const { TeamBrokerApi } = require('../../nodes/lib/TeamBrokerApi.js')

describe('TeamBrokerApi', function () {
    afterEach(function () {
        sinon.restore()
    })

    it('creates its client with got retries disabled', function () {
        const gotClient = { extend: sinon.stub().returns({}) }
        TeamBrokerApi(gotClient, { forgeURL: 'http://localhost:3000', teamId: 'team', instanceType: 'instance', instanceId: 'id', token: 'token' })
        gotClient.extend.calledOnce.should.be.true()
        gotClient.extend.firstCall.args[0].should.have.property('retry').which.deepEqual({ limit: 0 })
    })

    it('rejects when FlowFuse cannot be reached', async function () {
        // find a port nothing is listening on
        const server = net.createServer()
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
        const port = server.address().port
        await new Promise(resolve => server.close(resolve))

        const api = TeamBrokerApi(Got, { forgeURL: `http://127.0.0.1:${port}`, teamId: 'team', instanceType: 'instance', instanceId: 'id', token: 'token', API_TIMEOUT: 2000 })
        const err = await api.getClient().then(() => null, err => err)
        should.exist(err)
        // give a got retry timer the chance to fire, which would throw an uncaught error
        await new Promise(resolve => setTimeout(resolve, 1500))
    })
})
