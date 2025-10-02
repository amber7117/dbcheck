const search = require('./crawler/search');
const login = require('./crawler/login');

async function testSearch() {
  console.log('🔍 Testing search functionality...');
  
  try {
    // Test with a simple query
    const query = 'lim shi yang';
    console.log(`Testing query: "${query}"`);
    
    const result = await search(query);
    console.log('✅ Search completed successfully');
    console.log('Result:', result);
    
  } catch (error) {
    console.error('❌ Search test failed:', error.message);
    console.error('Full error:', error);
  }
}

async function testLogin() {
  console.log('🔐 Testing login functionality...');
  
  try {
    await login();
    console.log('✅ Login test completed successfully');
  } catch (error) {
    console.error('❌ Login test failed:', error.message);
    console.error('Full error:', error);
  }
}

async function runTests() {
  console.log('🚀 Starting tests...\n');
  
  // Test login first
  await testLogin();
  
  console.log('\n---\n');
  
  // Then test search
  await testSearch();
  
  console.log('\n🏁 Tests completed');
}

// Run tests if this file is executed directly
if (require.main === module) {
  runTests().catch(console.error);
}

module.exports = { testSearch, testLogin };
