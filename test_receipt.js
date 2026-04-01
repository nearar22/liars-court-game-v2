const { createClient, chains } = require('genlayer-js');

async function testReceipt() {
    console.log("Creating Genlayer client...");
    const client = createClient({ chain: chains.testnetBradbury });
    console.log("Getting receipt for my deploy tx...");
    const receipt = await client.getTransactionReceipt({ hash: '0x059f694936bb5827916ca8d2380f21eb094a8f16f6362e29f71449803c64e984' });
    console.log("Receipt:", Object.keys(receipt));
    console.log("Has data:", receipt.data || 'nope');
    console.log("Has result:", receipt.result || 'nope');
}
testReceipt();
