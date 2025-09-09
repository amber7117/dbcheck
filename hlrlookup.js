const axios = require('axios');

async function lookup(phoneNumber) {
  try {
    const response = await axios.get(`https://www.hlr-lookups.com/api/v2/hlr-lookup`, {
      params: {
        api_key: process.env.HLR_API_KEY,
        msisdn: phoneNumber
      }
    });
    return response.data;
  } catch (error) {
    console.error('Error performing HLR lookup:', error);
    return null;
  }
}

module.exports = {
  lookup
};
