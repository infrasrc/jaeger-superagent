const Tracer = require('jaeger-tracer');
const { Tags, FORMAT_HTTP_HEADERS, globalTracer } = Tracer.opentracing;
const tracer = globalTracer();
const NS_PER_SEC = 1e9;
const MS_PER_NS = 1e6;
const { get, post } = require('superagent');
const _ = require('lodash');
const URL = require('url');

class SuperAgentJaeger {

    constructor(parent) {
        this.name = 'superagent.request';
        this.span = tracer.startSpan(this.name, { childOf: parent });
        this.body = "";
        this._startAt = null;
        this._socketAssigned = null;
        this._dnsLookupAt = null;
        this._tcpConnectionAt = null;
        this._tlsHandshakeAt = null;
        this._firstByteAt = null;
        this._endAt = null;
    }

    getHrTimeDurationInMs(startTime, endTime) {
        if ((_.isEmpty(startTime) || _.isEmpty(endTime))) return undefined;
        const secondDiff = endTime[0] - startTime[0];
        const nanoSecondDiff = endTime[1] - startTime[1];
        const diffInNanoSecond = secondDiff * NS_PER_SEC + nanoSecondDiff;
        return diffInNanoSecond / MS_PER_NS
    }

    get socketAssigned() {
        return this.getHrTimeDurationInMs(this._startAt, this._socketAssigned);
    }

    get dnsLookup() {
        return this.getHrTimeDurationInMs(this._socketAssigned, this._dnsLookupAt);
    }

    get tcpConnection() {
        return this.getHrTimeDurationInMs(this._dnsLookupAt || this._socketAssigned, this._tcpConnectionAt);
    }

    get tlsHandshake() {
        return this.getHrTimeDurationInMs(this._tcpConnectionAt, this._tlsHandshakeAt);
    }

    get firstByte() {
        return this.getHrTimeDurationInMs(this._tlsHandshakeAt || this._tcpConnectionAt, this._firstByteAt);
    }

    get contentTransfer() {
        return this.getHrTimeDurationInMs(this._firstByteAt, this._endAt);
    }

    get total() {
        return this.getHrTimeDurationInMs(this._startAt, this._endAt);
    }

    get eventTimes() {
        return {
            socketAssigned: this.socketAssigned,
            dnsLookup: this.dnsLookup,
            tcpConnection: this.tcpConnection,
            tlsHandshake: this.tlsHandshake,
            firstByte: this.firstByte,
            contentTransfer: this.contentTransfer,
            total: this.total,
        }
    }

    startTrace(agent) {
        this.headers = {};
        this.agent = agent;
        this.url = agent.url;
        if (!agent.url.startsWith("http")) this.url = `http://${agent.url}`;
        this.uri = URL.parse(this.url);
        this.span.setTag(Tags.HTTP_URL, this.uri.href);
        this.span.setTag("http.protocol", this.uri.protocol.replace(':', ''));
        this.span.setTag("http.hostname", this.uri.hostname);
        this.span.setTag(Tags.HTTP_METHOD, agent.method);
        this.span.setTag(Tags.SPAN_KIND, Tags.SPAN_KIND_RPC_CLIENT);
        tracer.inject(this.span, FORMAT_HTTP_HEADERS, this.headers);
        this.agent.set(this.headers);
        this.agent.on('request', this.onRequest.bind(this));
        this.agent.on('error', this.endTrace.bind(this));
    }

    logEvent(event, value) {
        this.span.log({ event, value });
    }

    logError(errorObject, message, stack) {
        this.span.setTag(Tags.ERROR, true);
        this.span.log({ 'event': 'error', 'error.object': errorObject, 'message': message, 'stack': stack });
    }

    endTrace(error) {
        let { statusCode } = this.response || { statusCode: 500 };
        this.span.setTag(Tags.HTTP_STATUS_CODE, statusCode);
        this._endAt = process.hrtime();

        if (error) {
            this.logError(error, error.message, error.stack)
        } else {
            this.logEvent('response.body', this.body);
        }
        this.logEvent('eventTimes', this.eventTimes);
        this.span.finish();
    }

    onSocket(socket) {
        this._socketAssigned = process.hrtime();
        socket.on('lookup', this.lookup.bind(this));
        socket.on('connect', this.connect.bind(this));
        socket.on('secureConnect', this.secureConnect.bind(this));
        socket.on('timeout', this.timeout.bind(this));
    };

    lookup() {
        this._dnsLookupAt = process.hrtime();
    }

    connect() {
        this._tcpConnectionAt = process.hrtime();
    }

    secureConnect() {
        this._tlsHandshakeAt = process.hrtime();
    }

    timeout() {
        const error = new Error(`ETIMEDOUT for req.url: ${this.agent.url}`);
        this.endTrace({ status: 408, response: {}, message: error.message, stack: error.stack });
    }

    readable() {
        this._firstByteAt = process.hrtime();
    }

    data(data) {
        this.body += data;
    }

    onResponse(response) {
        this.response = response;
        this.response.once('readable', this.readable.bind(this));
        this.response.on('data', this.data.bind(this));
        this.response.on('end', this.endTrace.bind(this));
    }

    onRequest(request) {
        this.request = request;
        if(!_.isEmpty(this.request._data))
            this.logEvent("request.body", this.request._data);
        if(!_.isEmpty(this.request._formData))
            this.logEvent("request.formData", this.request._formData);
        this._startAt = process.hrtime()
        this.request.req.on('socket', this.onSocket.bind(this));
        this.request.req.on('response', this.onResponse.bind(this));
    }
}

module.exports = {
    get: (...args) => {
        const parentSpan = _.find(args, (a) => a.constructor.name === 'Span');
        const superAgentTracer = new SuperAgentJaeger(parentSpan);
        args = _.pull(args, parentSpan);
        return get(...args).use(superAgentTracer.startTrace.bind(superAgentTracer))
    },
    post: (...args) => {
        const parentSpan = _.find(args, (a) => a.constructor.name === 'Span');
        const superAgentTracer = new SuperAgentJaeger(parentSpan);
        args = _.pull(args, parentSpan);
        return post(...args).use(superAgentTracer.startTrace.bind(superAgentTracer))
    }
};