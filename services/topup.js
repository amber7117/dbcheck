const { TronWeb } = require('tronweb');
const User = require('../models/user');
const QueryLog = require('../models/queryLog');
const PrivateKey = require('../models/privateKey');

// USDT (TRC20) 合约地址
const USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
// 你的主钱包地址
const MAIN_WALLET = "TSxC8E5ZoGZGPikYEfXWP63nFcfzyxmiPY";

const tronWeb = new TronWeb({
  fullHost: "https://api.trongrid.io",
  headers: { "TRON-PRO-API-KEY": process.env.TRON_API_KEY || "" }, // 推荐加 API KEY
});

/**
 * 给用户分配充值地址
 */
async function assignDepositAddress(user) {
  // 如果用户已经有地址 → 直接返回
  if (user.depositAddress) {
    return user.depositAddress;
  }

  // 如果数据库已有私钥记录，但 User 没写入 depositAddress → 修复一次
  const existingKey = await PrivateKey.findOne({ userId: user.userId });
  if (existingKey) {
    user.depositAddress = existingKey.address;
    await user.save();
    return existingKey.address;
  }

  // 第一次分配 → 生成新地址
  const acc = await tronWeb.createAccount();

  // 保存到 User
  user.depositAddress = acc.address.base58;
  await user.save();

  // 保存到 PrivateKey
  const keyRecord = new PrivateKey({
    userId: user.userId,
    address: acc.address.base58,
    privateKey: acc.privateKey
  });
  await keyRecord.save();

  return acc.address.base58;
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
        // 更新积分：1 USDT = 1 分
        await User.updateOne(
          { userId: user.userId },
          { $inc: { points: Math.floor(usdt) } }
        );

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

        // 归集资金
        const keyRecord = await PrivateKey.findOne({ userId: user.userId });
        if (keyRecord) {
          try {
            const tx = await contract.transfer(MAIN_WALLET, balance).send({
              privateKey: keyRecord.privateKey
            });
            console.log(`归集成功: ${usdt} USDT -> ${MAIN_WALLET}, tx = ${tx}`);
          } catch (err) {
            console.error("归集失败:", err);
          }
        } else {
          console.error(`❌ 未找到用户 ${user.userId} 的私钥记录`);
        }
      }
    }
  } catch (err) {
    console.error("❌ Deposit check error:", err);
  }
}

module.exports = { assignDepositAddress, checkDeposits };

