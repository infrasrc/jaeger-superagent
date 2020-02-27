const Tracer = require('jaeger-tracer');
const { Tags, FORMAT_HTTP_HEADERS, globalTracer } = Tracer.opentracing;
const tracer = globalTracer();
const NS_PER_SEC = 1e9;
const MS_PER_NS = 1e6;
const request = require('superagent');
const _ = require('lodash');
const URL = require('url');
const util = require('util');
const methods = require('methods');
const ref = {};

methods.forEach(method => {
    const name = method;
    method = (method === 'del') ? 'Delete' : method.toUpperCase();
    ref[name] = request[name];
    request[name] = (...args) => {
        const parentSpan = _.find(args, (a) => 'Span' === _.get(a, 'constructor.name')) || null;
        args = _.pull(args, parentSpan);
        const request = ref[name](...args);
        return request.use((agent) => {
            agent.on('request', (request) => {
                const superAgentTracer = new SuperAgentJaeger(request, parentSpan);
                superAgentTracer.onRequest(request);
            });           
        });
    };
});

class JaegerCustomHttpError extends Error {
    constructor(message, response, status) {
        super(message); 
        this.message = message;
        this.response = util.inspect(response, false);
        this.status = status;
    }
}
class SuperAgentJaeger {

    constructor(request, parentSpan) {
        this.url = request.url;
        if (!this.url.startsWith("http")) this.url = `http://${this.url}`;
        this.uri = URL.parse(this.url);
        this.parentSpan = parentSpan;
        this.name = 'superagent.request';
        this.body = "";
        this.queryParams = {};
        this._startAt = null;
        this._socketAssigned = null;
        this._dnsLookupAt = null;
        this._tcpConnectionAt = null;
        this._tlsHandshakeAt = null;
        this._firstByteAt = null;
        this._endAt = null;
        this._query = request.query.bind(request);
        this.query = this.query.bind(this);
        this.readable = this.readable.bind(this);
        this.data = this.data.bind(this);
        this.onRequest = this.onRequest.bind(this);
        this.endTrace = this.endTrace.bind(this);
        this.lookup = this.lookup.bind(this);
        this.connect = this.connect.bind(this);
        this.secureConnect = this.secureConnect.bind(this);
        this.timeout = this.timeout.bind(this);
        this.onSocket = this.onSocket.bind(this);
        this.onResponse = this.onResponse.bind(this);
        this.onError = this.onError.bind(this);
        request.query = this.query;
    }

    query(param) {
        if (!_.isEmpty(param)) {
            this.queryParams = _.merge(this.queryParams, param);
        }
        return this._query(param);
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

    logEvent(event, value) {
        this.span.log({ event, value });
    }

    logError(errorObject) {
        Tracer.logError(this.span, errorObject);
        errorObject.traced = true;
    }

    async endTrace() {

        const statusCode = _.get(this.response, 'statusCode', 500);
        const statusMessage = _.get(this.response, 'statusMessage', this.response.text);
        this.span.setTag(Tags.HTTP_STATUS_CODE, statusCode);
        this._endAt = process.hrtime();
        this.logEvent('response.body', this.body);
        this.logEvent('eventTimes', this.eventTimes);
        if (this.response.statusCode === 200) this.span.finish();
        else this.onError(new JaegerCustomHttpError(statusMessage, this.response, statusCode));
    }

    onSocket(socket) {
        this._socketAssigned = process.hrtime();
        socket.on('lookup', this.lookup);
        socket.on('connect', this.connect);
        socket.on('secureConnect', this.secureConnect);
        socket.on('timeout', this.timeout);
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
        const error = new Error(`ETIMEDOUT for req.url: ${this.url}`);
        this.onError({ status: 408, response: {}, message: error.message, stack: error.stack });
    }

    readable() {
        this._firstByteAt = process.hrtime();
    }

    data(data) {
        this.body += data;
    }

    onError(error) {
        this.logError(error);
        this.span.finish();
    }

    onResponse(response) {
        this.response = response;

        response.span = this.span;
        response.once('readable', this.readable);
        response.on('data', this.data);
        response.on('end', this.endTrace);
    }

    onRequest(request) {
        this.span = tracer.startSpan(this.name, { childOf: this.parentSpan });
        const headers = {};
        this.span.setTag(Tags.HTTP_URL, this.uri.href);
        this.span.setTag("http.protocol", this.uri.protocol.replace(':', ''));
        this.span.setTag("http.hostname", this.uri.hostname);
        this.span.setTag(Tags.HTTP_METHOD, request.method);
        this.span.setTag(Tags.SPAN_KIND, Tags.SPAN_KIND_RPC_CLIENT);
        tracer.inject(this.span, FORMAT_HTTP_HEADERS, headers);

        request.set("uber-trace-id", headers["uber-trace-id"]);

        if (!_.isEmpty(request._data))
            this.logEvent("request.body", request._data);

        if (!_.isEmpty(request._formData))
            this.logEvent("request.formData", request._formData);

        _.each(request._header, (headerValue, headerName) => {
            if (headerName) this.span.setTag(`header.${headerName}`, headerValue);
        });

        _.each(this.queryParams, (queryValue, queryName) => {
            if (queryName) this.span.setTag(`query.${queryName}`, queryValue);
        });

        this._startAt = process.hrtime();

        request.req.on('socket', this.onSocket);
        request.req.on('response', this.onResponse);
        request.req.on('error', this.onError);

    }
}

module.exports = request;
