const { ethers } = require('ethers');
const provider = new ethers.providers.JsonRpcProvider('https://eth-goerli.g.alchemy.com/v2/Kb0-sSQHUeURzm-QCj-pXKS0Viefa_kX');
provider.getBlockNumber().then(console.log)