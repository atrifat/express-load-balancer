import express from "express";
import bodyparser from 'body-parser';
import * as dotenv from 'dotenv';
import axios from "axios";
import { LRUCache } from 'lru-cache';
import { SequentialRoundRobin, RandomRoundRobin } from "round-robin-js";
import sha256 from "js-sha256";
import hash from "object-hash";
import { performance } from "node:perf_hooks";
import { exit } from "node:process";
import { handleFatalError } from "./util.mjs";
import { retry } from "@ultraq/promise-utils";
import bearerToken from 'express-bearer-token';

// Load env variable from .env
dotenv.config();

const ENABLE_CACHE = process.env.ENABLE_CACHE ? process.env.ENABLE_CACHE === 'true' : false;
// Default cache TTL in ms
const CACHE_TTL = process.env.CACHE_TTL ? parseInt(process.env.CACHE_TTL) : 300000;
const BACKEND_SERVER_LIST = process.env.BACKEND_SERVER_LIST ? process.env.BACKEND_SERVER_LIST.split(',').map(s => s.trim()) : [];
const ROUND_ROBIN_STRATEGY = process.env.ROUND_ROBIN_STRATEGY || 'sequential';
const LB_ENABLE_AUTH_TOKEN = process.env.LB_ENABLE_AUTH_TOKEN ? process.env.LB_ENABLE_AUTH_TOKEN === 'true' : false;
const LB_AUTH_TOKEN = process.env.LB_AUTH_TOKEN || "myapitokenchangethislater";

if (BACKEND_SERVER_LIST.length == 0) {
  handleFatalError(new Error("Backend server cannot be empty"));
}

// console.debug(BACKEND_SERVER_LIST);
// exit(1);

// Only retry failed request maximum 2 times
const retryStrategy = function (result, error, attempts) {
  return !!error && attempts < 2 ? attempts * 250 : -1;
}

const responseCache = new LRUCache(
  {
    max: 500,
    maxSize: 5000,
    sizeCalculation: (value, key) => {
      return value.toString().length;
    },
    // how long to live in ms
    ttl: CACHE_TTL,
  }
)

const app = express();

// Application servers
const servers = BACKEND_SERVER_LIST;
let availableServers;

switch (ROUND_ROBIN_STRATEGY) {
  case 'sequential':
    availableServers = new SequentialRoundRobin(servers);
    break;
  case 'random':
    availableServers = new RandomRoundRobin(servers);
    break;
  default:
    availableServers = new SequentialRoundRobin(servers);
    break;
}

const PORT = process.env.PORT || 8081;

// Whenever receive new request will forward to application server
const loadBalancerHandler = async (req, res) => {

  // Extract properties from request object
  const { method, url, headers, body } = req;

  const ip = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.connection.remoteAddress;

  const newHeaders = {};
  const skipHeadersKey = ["content-length", "host"];

  if (LB_ENABLE_AUTH_TOKEN) {
    // Don't forward current authorization header to backend
    skipHeadersKey.push("authorization");
  }
  Object.keys(headers).forEach((key) => {
    const existSkipHeaderKey = skipHeadersKey.includes(key.toLowerCase());
    if (!existSkipHeaderKey) newHeaders[key] = headers[key];
  });

  console.debug(ip);
  console.debug(headers);
  // console.debug(newHeaders);
  console.debug(url);
  // exit();

  // Make request key from combination of hash from url, method, and body object hash
  const req_key = sha256(`${url} ${method} ` + hash.sha1(body));

  // Return cached response immediately if it exists
  if (ENABLE_CACHE && responseCache.has(req_key)) {
    console.debug("Get from cache");
    return res.send(responseCache.get(req_key));
  }

  // Select the server using round robin strategy to forward the request
  const server = availableServers.next();
  console.debug("Connect to " + server.value);

  try {
    const startTimeRequest = performance.now();

    // Requesting to underlying application server
    const response = await retry(() => axios({
      url: `${server.value}${url}`,
      method: method,
      headers: newHeaders,
      data: body
    }), retryStrategy);

    const endTimeRequest = performance.now();

    console.debug("Request to " + server.value + " took " + (endTimeRequest - startTimeRequest) + " ms");

    // Send cache if it is available
    if (ENABLE_CACHE) responseCache.set(req_key, response.data);

    // Send back the response data from application server to client
    res.status(response.status).header(response.headers).send(response.data);
  }
  catch (err) {
    // Send back the error message
    console.error(err);
    const statusCode = err.response ? err.response.status : 500;
    const message = err.response ? typeof err.response.data.message ? err.response.data.message : err.response.reason.message || err.response.code || err.message || "Server error!" : "Server error!";
    res.status(statusCode).header(err.response.headers).send(message);
  }
}

app.use(bodyparser.json({ limit: '5mb' }));

if (LB_ENABLE_AUTH_TOKEN) {
  // Extract auth token if it is exist
  app.use(bearerToken());
  
  // Simple authentication middleware
  const authMiddleware = function (req, res, next) {
    if (LB_ENABLE_AUTH_TOKEN) {
      const token = typeof req.token !== 'undefined' ? req.token : null;
      if (!token) {
        const error = new Error('Missing API token');
        error.statusCode = 401
        return res.status(401).json({ "message": error.message });
      }

      if (LB_AUTH_TOKEN !== token) {
        const error = new Error('Invalid API token');
        error.statusCode = 401
        return res.status(401).json({ "message": error.message });
      }
    }
    next();
  };

  app.use(authMiddleware);
}
// Pass any request to loadBalancerHandler
app.use((req, res) => { loadBalancerHandler(req, res) });

// Listen on PORT 8080
app.listen(PORT, err => {
  err ?
    console.debug(`Failed to listen on PORT ${PORT}`) :
    console.debug("Load Balancer Server "
      + `listening on PORT ${PORT}`);
});
