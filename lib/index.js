'use strict'

var chalk = require('chalk')
var debug = require('debug-log')('mashape-analytics')
var extend = require('xtend')
var helpers = require('./helpers')
var Queue = require('./queue')
var url = require('url')
var util = require('util')

module.exports = function Agent (serviceToken, environment, options) {
  // ensure agent key exists
  if (!serviceToken) {
    throw new Error('a service token is required, visit: https://analytics.mashape.com/ to obtain one')
  }

  // ensure instance type
  if (!(this instanceof Agent)) {
    return new Agent(serviceToken, environment, options)
  }

  // this alias
  var self = this

  // no environment specified
  if (typeof environment === 'object') {
    options = environment
    environment = null
  }

  // setup options with defaults
  self.opts = extend({
    host: 'socket.analytics.mashape.com',
    port: 443,
    ssl: true,
    limits: {
      bodySize: 0
    },
    queue: {
      batch: 1,
      entries: 100
    }
  }, options)

  // setup request queue
  this.queue = new Queue(serviceToken, environment, self.opts)

  // API Recorder Middleware
  // TODO use tamper or tamper-esque method to get raw body
  //      to determine raw content size to get infer compression size
  return function (req, res, next) {
    var reqReceived = new Date()

    // assign clientIpAddress for each call
    self.clientIPAddress = helpers.getClientAddress(req)

    // body container
    var bytes = {
      req: 0,
      res: 0
    }

    var bodies = {
      req: {
        size: 0,
        base64: ''
      },

      res: {
        size: 0,
        base64: ''
      }
    }

    // buffer container
    var chunked = {
      req: [],
      res: []
    }

    // grab the request body
    if (self.opts.limits.bodySize > 0) {
      req.on('data', function (chunk) {
        bytes.req += chunk.length

        if (bytes.req <= self.opts.limits.bodySize) {
          chunked.req.push(chunk)
        }
      })
    }

    // construct the request body
    if (self.opts.limits.bodySize > 0) {
      req.on('end', function () {
        var body = Buffer.concat(chunked.req)

        bodies.req.size = body.length
        bodies.req.base64 = body.toString('utf8')
      })
    }

    // store original methods for later use
    var func = {
      end: res.end,
      write: res.write
    }

    // override node's http.ServerResponse.write method
    res.write = function (chunk, encoding) {
      // call the original http.ServerResponse.write method
      func.write.call(res, chunk, encoding)

      bytes.res += chunk.length

      if (bytes.res <= self.opts.limits.bodySize) {
        chunked.res.push(chunk)
      }
    }

    // override node's http.ServerResponse.end method
    res.end = function (data, encoding) {
      // call the original http.ServerResponse.end method
      func.end.call(res, data, encoding)

      if (req._mashapeAnalytics) {return}
      req._mashapeAnalytics = true

      if (chunked.res.length) {
        data = Buffer.concat(chunked.res)
      }

      // construct body
      bodies.res.size = data ? data.length : 0
      bodies.res.base64 = data ? data.toString('utf8') : ''

      var agentResStartTime = new Date()
      var reqHeadersArr = helpers.objectToArray(req.headers)

      var resHeaders = helpers.parseResponseHeaderString(res._header)

      var resContentLength = parseInt(helpers.getHeaderValue(resHeaders.headersArr, 'content-length', 0), 10)
      var resBodySize = resContentLength === 0 && bodies.res.size > 0 ? bodies.res.size : resContentLength

      var reqContentLength = parseInt(helpers.getHeaderValue(reqHeadersArr, 'content-length', 0), 10)
      var reqBodySize = reqContentLength === 0 && bodies.req.size > 0 ? bodies.req.size : reqContentLength

      var waitTime = agentResStartTime.getTime() - reqReceived.getTime()
      var protocol = req.connection.encrypted ? 'https' : 'http'

      var entry = {
        time: waitTime, // TODO
        serverIPAddress: helpers.getServerAddress(),
        startedDateTime: agentResStartTime.toISOString(),

        request: {
          cookies: [],
          method: req.method,
          url: util.format('%s://%s%s', protocol, req.headers.host, req.url),
          httpVersion: 'HTTP/' + req.httpVersion,
          queryString: helpers.objectToArray(url.parse(req.url, true).query),
          headers: reqHeadersArr,
          headersSize: helpers.getReqHeaderSize(req),
          bodySize: reqBodySize,
          postData: {
            mimeType: helpers.getHeaderValue(reqHeadersArr, 'content-type', 'application/octet-stream'),
            text: self.opts.limits.bodySize > 0 ? bodies.req.base64 : '' // TODO
          }
        },

        response: {
          cookies: [],
          redirectURL: '',
          status: res.statusCode,
          statusText: resHeaders.statusText,
          httpVersion: resHeaders.version,
          headers: resHeaders.headersArr,
          headersSize: res._header ? new Buffer(res._header).length : 0,
          bodySize: resBodySize,
          content: {
            // TODO measure before compression, if any
            size: resBodySize,
            mimeType: helpers.getHeaderValue(resHeaders.headersArr, 'content-type', 'application/octet-stream'),
            text: self.opts.limits.bodySize > 0 ? bodies.res.base64 : ''
          }
        },

        cache: {},

        timings: {
          send: 0, // TODO
          wait: waitTime,
          receive: 0  // TODO
        }
      }

      debug('[%s] triggered on [%s] %s %s', chalk.yellow('agent'), chalk.grey(res.statusCode), entry.request.method, chalk.grey(entry.request.url))

      // send to queue
      self.queue.push(entry)
    }

    if (typeof next === 'function') {
      next()
    }
  }
}
