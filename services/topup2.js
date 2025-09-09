const { TronWeb } = require('tronweb');
const User = require('../models/user');
const QueryLog = require('../models/queryLog');

// USDT (TRC20) 合约地址
const USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
// 你的主钱包地址
const MAIN_WALLET = "TSxC8E5ZoGZGPikYEfXWP63nFcfzyxmiPY";

const tronWeb = new TronWeb({
  fullHost: "https://api.trongrid.io",
  headers: { "TRON-PRO-API-KEY": process.env.TRON_API_KEY || "" }, // optional but recommended
});


/**
 * 给用户分配充值地址
 */
async function assignDepositAddress(user) {
  if (!user.depositAddress) {
    const acc = await tronWeb.createAccount();
    user.depositAddress = acc.address.base58;
    user.privateKey = acc.privateKey; // ⚠️ 建议生产环境安全存储
    await user.save();
  }
  return user.depositAddress;
}

/**
 * 检查所有用户充值
 */
async function checkDeposits(bot) {
  try {
    const users = await User.find({ depositAddress: { $exists: true } });
    const contract = await tronWeb.contract().at(USDT_CONTRACT);

    for (const user of users) {
      const balance = await contract.balanceOf(user.depositAddress).call();
      const usdt = tronWeb.toDecimal(balance) / 1e6;

      if (usdt >= 100) {
        // 更新积分
        await User.updateOne({ userId: user.userId }, { $inc: { points: Math.floor(usdt) } });

        // 保存充值记录
        await new QueryLog({
          userId: user.userId,
          query: `[Topup ${usdt} USDT]`,
          results: 0,
          success: true
        }).save();

        // 通知用户
        await bot.telegram.sendMessage(
          user.userId,
          `✅ ${usdt} USDT confirmed. Balance updated (+${Math.floor(usdt)} points).`
        );

        // （可选）归集资金到主钱包
        try {
          const tx = await contract.transfer(MAIN_WALLET, balance).send({ privateKey: user.privateKey });
          console.log(`归集成功: ${usdt} USDT -> ${MAIN_WALLET}, tx = ${tx}`);
        } catch (err) {
          console.error("归集失败:", err);
        }
      }
    }
  } catch (err) {
    console.error("❌ Deposit check error:", err);
  }
}

module.exports = { assignDepositAddress, checkDeposits };

