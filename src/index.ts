/**
 * Welcome to Cloudflare Workers! This is your first scheduled worker.
 *
 * - Run `wrangler dev --local` in your terminal to start a development server
 * - Run `curl "http://localhost:8787/cdn-cgi/mf/scheduled"` to trigger the scheduled event
 * - Go back to the console to see what your worker has logged
 * - Update the Cron trigger in wrangler.toml (see https://developers.cloudflare.com/workers/wrangler/configuration/#triggers)
 * - Run `wrangler publish --name my-worker` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/runtime-apis/scheduled-event/
 */

import { ethers } from "ethers";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import ETHRegistrarControllerABI from "./ETHRegistrarController.json";

export interface Env {
  // Example binding to KV. Learn more at https://developers.cloudflare.com/workers/runtime-apis/kv/
  // OPTIDOMAINS_TESTNET_1: KVNamespace;

  SUPABASE_KEY: string;
  DATA_TABLE: string;
  BACKEND_PK: string;
  ETH_ARCHIVE_NODE: string;

  //
  // Example binding to Durable Object. Learn more at https://developers.cloudflare.com/workers/runtime-apis/durable-objects/
  // MY_DURABLE_OBJECT: DurableObjectNamespace;
  //
  // Example binding to R2. Learn more at https://developers.cloudflare.com/workers/runtime-apis/r2/
  // MY_BUCKET: R2Bucket;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
  "Access-Control-Max-Age": "86400",
};

const CHAIN_CONFIG = {
  evm_420: {
  	url: `https://goerli.optimism.io`,
  	tags: ['test', 'use_root'],
  	chainId: 420,
  	startingBlock: 8355000,
    blockLimit: 1000,
    contractAddress: "0x90b765bcb20121828Ec92ef957645d86722D16cA",
    registrarControllerAddress: "0x3560E97fd220668eBF9189a9695aA111be33Af67",
  },
  // evm_84531: {
  //   url: `https://goerli.base.org`,
  //   tags: ["test", "use_root"],
  //   chainId: 84531,
  //   startingBlock: 1496000,
  //   blockLimit: 1000,
  //   contractAddress: "0x88D711a0BAc694e7C2D71Fcd7AC7896A02970911",
  //   registrarControllerAddress: "0xE11572B0F18DC78F30cDDf44c402a5B79511105A",
  // },
  // evm_5: {
  //   url: `https://eth-goerli.g.alchemy.com/v2/Kb0-sSQHUeURzm-QCj-pXKS0Viefa_kX`,
  //   tags: ["test", "use_root"],
  //   chainId: 5,
  //   startingBlock: 8555300,
  //   blockLimit: 100,
  //   contractAddress: "0x4a7c7a621834ae33282ae71e403b94ac11024070",
  //   registrarControllerAddress: "",
  // },
  // evm_5: {
  //   url: `https://eth-goerli.g.alchemy.com/v2/Kb0-sSQHUeURzm-QCj-pXKS0Viefa_kX`,
  //   tags: ["test", "use_root"],
  //   chainId: 5,
  //   startingBlock: 8555300,
  //   blockLimit: 100,
  //   contractAddress: "0xa3412b5849f8ffE009Fc04A6cb177164eb5e909c",
  //   registrarControllerAddress: "0x3801e62AfF33B6D2708DcE97aa04611894f80a21",
  // },
};

function decodeName(hex: string): string {
  hex = hex.substring(2);
  const result: string[] = [];

  while (true) {
    const len = parseInt(hex.substring(0, 2), 16);

    if (!len || len <= 0) break;

    hex = hex.substring(2);

    const str = ethers.utils.toUtf8String("0x" + hex.substring(0, 2 * len));

    hex = hex.substring(2 * len);

    result.push(str);
  }

  return result.join(".").replace("\0", "");
}

class ResponseError extends Error {
  status: number
  
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

interface Context {
  supabase: SupabaseClient;
  env: Env;
}

interface Record {
  chain: string;
  node: string;
  name: string;
  owner: string;
  expiry: number;
  block_number: number;
}

interface RecordUpdate {
  node: string;
  chain: string;
  owner: string;
  expiry?: number;
}

// Get function
export function getNameHash(domain: string, initialHash: string = '0x0000000000000000000000000000000000000000000000000000000000000000') {
  const parts = domain.split('.').reverse();
  let result = initialHash;
  for (let part of parts) {
    result = ethers.utils.solidityKeccak256(['bytes32', 'bytes32'], [result, ethers.utils.keccak256(ethers.utils.toUtf8Bytes(part))])
  }
  return result;
}

async function getRecord(context: Context, node: string, chain?: string) {
  let promise = context.supabase
    .from(context.env.DATA_TABLE)
    .select("*")
    .eq("node", node);

  if (chain) {
    promise = promise.eq("chain", chain);
  }

  let { data, error } = await promise;

  if (error) {
    console.error(error);
  }

  return data;
}

async function getRecordByName(context: Context, name: string, chain?: string) {
  let promise = context.supabase
    .from(context.env.DATA_TABLE)
    .select("*")
    .eq("name", name);

  if (chain) {
    promise = promise.eq("chain", chain);
  }

  let { data, error } = await promise;

  if (error) {
    console.error(error);
  }

  return data;
}

async function getOwnedDomains(
  context: Context,
  owner: string,
  chain?: string
) {
  let promise = context.supabase
    .from(context.env.DATA_TABLE)
    .select("*")
    .eq("owner", owner);

  if (chain) {
    promise = promise.eq("chain", chain);
  }

  let { data, error } = await promise;

  if (error) {
    console.error(error);
  }

  return data;
}

async function getBlockNumber(context: Context, chain: string) {
  let { data, error } = await context.supabase
    .from(context.env.DATA_TABLE + "_blocknumber")
    .select("*")
    .eq("chain", chain);

  if (error) {
    console.error(error);
  }

  if (!data || !data.length) {
    return CHAIN_CONFIG[chain].startingBlock;
  } else {
    return data[0].block_number;
  }
}

// Update function
async function updateOwner(context: Context, records: RecordUpdate[]) {
  for (let record of records) {
    console.log("Update owner", record.node, record.owner);
  }

  const { data, error } = await context.supabase.rpc(
    "update_many_" + context.env.DATA_TABLE,
    {
      payload: records.map((record) => ({
        ...record,
        updated_at: new Date(),
      })),
    }
  );

  if (error) {
    console.error(error);
  }
}

async function insertRecords(context: Context, records: Record[]) {
  const { data, error } = await context.supabase
    .from(context.env.DATA_TABLE)
    .upsert(
      records.map((record) => ({
        ...record,
        updated_at: new Date(),
      }))
    );

  if (error) {
    console.error(error);
  }
}

async function updateBlockNumber(
  context: Context,
  chain: string,
  blockNumber: number
) {
  const { data, error } = await context.supabase
    .from(context.env.DATA_TABLE + "_blocknumber")
    .upsert([
      {
        chain,
        block_number: blockNumber,
        updated_at: new Date(),
      },
    ]);

  if (error) {
    console.error(error);
  }
}

async function checkENSOwner(context: Context, owner: string, name: string): Promise<boolean> {
  const provider = new ethers.providers.JsonRpcProvider({
    url: context.env.ETH_ARCHIVE_NODE,
    skipFetchSetup: true,
  });

  const address = await provider.resolveName(name);

  if (!address) return true;

  return address.toLowerCase() == owner.toLowerCase();
}

async function handleRequest(context: Context, route: string[], body: any) {
  switch (route[0]) {
    case "node": {
      const node = route[1];
      return await getRecord(context, node, body.chain);
    }

    case "name": {
      const name = route[1];
      return await getRecordByName(context, name, body.chain);
    }

    case "owner": {
      const owner = route[1];
      return await getOwnedDomains(context, owner, body.chain);
    }

    case "commit": {
      // Sign commitment from backend
      if (!body.chainId) {
        throw new ResponseError(400, "Chain ID is required");
      }

      const chainName = "evm_" + body.chainId;
      const chainConfig = CHAIN_CONFIG[chainName];

      const privateKey = context.env.BACKEND_PK;
      const provider = new ethers.providers.JsonRpcProvider({
        url: chainConfig.url,
        skipFetchSetup: true,
      });

      // If .base then check if owned .op
      const parts: string[] = body.name.split(".")
      if (parts[parts.length - 1] == 'base') {
        const records = await getRecordByName(context, parts.slice(0, -1).join('.') + '.op')
        const record = records?.find(x => x.chain == 'evm_420')
        if (!record) {
          throw new ResponseError(400, "Not owning .op yet");
        }

        if (record.owner.toLowerCase() != body.owner.toLowerCase()) {
          throw new ResponseError(400, "Not owner of .op domains");
        }
      }

      // check for .eth holding
      if (!await checkENSOwner(context, body.owner, parts.slice(0, -1).join('.') + '.eth')) {
        throw new ResponseError(400, "ENS domains is owned by other");
      }

      // Call the makeCommitment function with the specified value
      const contract = new ethers.Contract(
        chainConfig.registrarControllerAddress,
        ETHRegistrarControllerABI,
        provider
      );
      const commitment = await contract.makeCommitment(
        body.name,
        body.owner,
        body.duration,
        body.secret,
        body.resolver,
        body.data,
        body.reverseRecord,
        body.ownerControlledFuses
      );

      // const commitmentTimestamp = await contract.commitments(commitment);
      const commitmentTimestamp = body.commitmentTimestamp;

      // Define the input types and values of the transaction data
      const inputTypes = ["bytes32", "uint256", "uint256"];
      const inputValues = [commitment, commitmentTimestamp, body.chainId];

      console.log(inputValues)

      // ABI-encode the transaction data
      const abiEncodedTransactionData = ethers.utils.defaultAbiCoder.encode(
        inputTypes,
        inputValues
      );

      console.log(ethers.utils.keccak256(abiEncodedTransactionData))

      const signingKey = new ethers.utils.SigningKey(privateKey);
      const signature = signingKey.signDigest(
        ethers.utils.keccak256(abiEncodedTransactionData)
      );

      console.log(signature)

      return {
        signature: ethers.utils.hexlify(
          ethers.utils.concat([
            signature.r,
            signature.s,
            ethers.utils.hexlify(signature.v),
          ])
        ),
      };
    }
  }
}

function handleOptions(request) {
  // Make sure the necessary headers are present
  // for this to be a valid pre-flight request
  let headers = request.headers;
  if (
    headers.get("Origin") !== null &&
    headers.get("Access-Control-Request-Method") !== null &&
    headers.get("Access-Control-Request-Headers") !== null
  ) {
    // Handle CORS pre-flight request.
    // If you want to check or reject the requested method + headers
    // you can do that here.
    let respHeaders = {
      ...corsHeaders,
      // Allow all future content Request headers to go back to browser
      // such as Authorization (Bearer) or X-Client-Name-Version
      "Access-Control-Allow-Headers": request.headers.get(
        "Access-Control-Request-Headers"
      ),
    };
    return new Response(null, {
      headers: respHeaders,
    });
  } else {
    // Handle standard OPTIONS request.
    // If you want to allow other HTTP Methods, you can do that here.
    return new Response(null, {
      headers: {
        Allow: "GET, HEAD, POST, OPTIONS",
      },
    });
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const { url, method } = request;
    const route = new URL(url).pathname.substring(1).split("/");

    // Create a URLSearchParams object from the request URL's search params
    const searchParams = new URLSearchParams(new URL(url).search);

    // Get an iterator over the search parameters and convert them to an array
    const searchParamsArray = Array.from(searchParams.entries());

    // Convert the array of search parameters to a JSON object using Object.fromEntries()
    const searchParamsJson = Object.fromEntries(searchParamsArray);

    const supabaseUrl = "https://dtdtzmqbttfermhrxnpy.supabase.co";
    const supabaseKey = env.SUPABASE_KEY;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const context: Context = {
      supabase,
      env,
    };

    let response: Response;

    try {
      if (method === "OPTIONS") {
        return handleOptions(request)
      } else if (method == "POST") {
        const body = await request.json();

        response = new Response(
          JSON.stringify(await handleRequest(context, route, body)),
          {
            headers: {
              "Content-Type": "application/json",
            },
          }
        );
      } else {
        response = new Response(
          JSON.stringify(await handleRequest(context, route, searchParamsJson)),
          {
            headers: {
              "Content-Type": "application/json",
            },
          }
        );
      }
    } catch (err) {
      console.error(err);

      response = new Response(
        JSON.stringify({
          message: "Internal server error",
        }),
        {
          headers: {
            "Content-Type": "application/json",
          },
          status: 500,
        }
      );
    }

    response.headers.set("Access-Control-Allow-Origin", "*")
    response.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")

    return response
  },
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    const supabaseUrl = "https://dtdtzmqbttfermhrxnpy.supabase.co";
    const supabaseKey = env.SUPABASE_KEY;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const context: Context = {
      supabase,
      env,
    };

    for (let chainName in CHAIN_CONFIG) {
      const chainConfig = CHAIN_CONFIG[chainName];
      let lastBlockNumber = await getBlockNumber(context, chainName);

      console.log(lastBlockNumber, chainConfig.url);

      const provider = new ethers.providers.JsonRpcProvider({
        url: chainConfig.url,
        skipFetchSetup: true,
      });
      const headBlockNumber = await provider.getBlockNumber();

      const fromBlock = lastBlockNumber;
      const toBlock = Math.min(
        headBlockNumber,
        lastBlockNumber + chainConfig.blockLimit
      ); // Retrieve events up to the current block.

      const contractAddress = chainConfig.contractAddress; // Replace with the address of your ERC1155 contract.

      // Fetch NameWrapped
      {
        // event NameWrapped(
        // 	bytes32 indexed node,
        // 	bytes name,
        // 	address owner,
        // 	uint32 fuses,
        // 	uint64 expiry
        // );

        const abi = [
          "event NameWrapped(bytes32 indexed node, bytes name, address owner, uint32 fuses, uint64 expiry)",
        ];

        const topics = [
          ethers.utils.id("NameWrapped(bytes32,bytes,address,uint32,uint64)"),
        ];

        const filter = {
          address: contractAddress,
          topics: topics,
          fromBlock: fromBlock,
          toBlock: toBlock,
        };

        // Define an instance of the contract ABI.
        const iface = new ethers.utils.Interface(abi);

        const logs = await provider.getLogs(filter);
        const records: Record[] = [];

        logs.forEach((log) => {
          const parsedLog = iface.parseLog(log);
          console.log(
            parsedLog.args.node.toString(),
            parsedLog.args.name,
            decodeName(parsedLog.args.name)
          );

          records.push({
            chain: chainName,
            node: parsedLog.args.node.toString(),
            name: decodeName(parsedLog.args.name),
            owner: parsedLog.args.owner,
            expiry: parsedLog.args.expiry.toNumber(),
            block_number: log.blockNumber,
          });
        });

        if (records.length > 0) {
          await insertRecords(context, records);
        }
      }

      // Fetch Transfer
      {
        const abi = [
          "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
        ];

        const topics = [
          ethers.utils.id(
            "TransferSingle(address,address,address,uint256,uint256)"
          ),
        ];

        const filter = {
          address: contractAddress,
          topics: topics,
          fromBlock: fromBlock,
          toBlock: toBlock,
        };

        // Define an instance of the contract ABI.
        const iface = new ethers.utils.Interface(abi);

        const logs = await provider.getLogs(filter);
        const records: RecordUpdate[] = [];

        logs.forEach((log) => {
          const parsedLog = iface.parseLog(log);

          if (
            parsedLog.args.from != "0x0000000000000000000000000000000000000000"
          ) {
            records.push({
              chain: chainName,
              node: ethers.utils.hexZeroPad(
                ethers.utils.hexlify(parsedLog.args.id),
                32
              ),
              owner: parsedLog.args.to,
            });
          }
        });

        if (records.length > 0) {
          await updateOwner(context, records);
        }
      }

      // Fetch Transfer Batch
      {
        const abi = [
          "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
        ];

        const topics = [
          ethers.utils.id(
            "TransferBatch(address,address,address,uint256[],uint256[])"
          ),
        ];

        const filter = {
          address: contractAddress,
          topics: topics,
          fromBlock: fromBlock,
          toBlock: toBlock,
        };

        // Define an instance of the contract ABI.
        const iface = new ethers.utils.Interface(abi);

        const logs = await provider.getLogs(filter);
        const records: RecordUpdate[] = [];

        logs.forEach((log) => {
          const parsedLog = iface.parseLog(log);

          if (
            parsedLog.args.from != "0x0000000000000000000000000000000000000000"
          ) {
            for (let i = 0; i < parsedLog.args.ids.length; i++) {
              records.push({
                chain: chainName,
                node: ethers.utils.hexZeroPad(
                  ethers.utils.hexlify(parsedLog.args.ids[i]),
                  32
                ),
                owner: parsedLog.args.to,
              });
            }
          }
        });

        if (records.length > 0) {
          await updateOwner(context, records);
        }
      }

      // Update block number forward
      await updateBlockNumber(context, chainName, toBlock);
    }
  },
};
