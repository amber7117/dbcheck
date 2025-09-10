const HlrLookupClient = require('node-hlr-client');
const { hlr } = require('./config');

let client;
function getClient() {
  if (!client) client = new HlrLookupClient(hlr.key, hlr.secret);
  return client;
}

module.exports = { getClient };