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
  evm_10: {
  	url: `https://opt-mainnet.g.alchemy.com/v2/mp34Jjv42ADWDWBREqAhwUIGMu_e-UUZ`,
  	tags: ['test', 'use_root'],
  	chainId: 10,
  	startingBlock: 106039800,
    blockLimit: 100,
    contractAddress: "0xB02ED980693e14E082F0A3A33060046Ae8495EB2",
    registrarControllerAddress: "0xB02EDc247246ACD78294c62F403B3e64D5917031",
    // contractAddress: "0x888811F1B21176E15FB60DF500eA85B490Dd2836",
    // registrarControllerAddress: "0x8888117A2d8cC4e02A9A9691Ba0e166b2842360D",
  },
  // evm_420: {
  // 	url: `https://goerli.optimism.io`,
  // 	tags: ['test', 'use_root'],
  // 	chainId: 420,
  // 	startingBlock: 12737481,
  //   blockLimit: 100,
  //   contractAddress: "0x888811F1B21176E15FB60DF500eA85B490Dd2836",
  //   registrarControllerAddress: "0x8888117A2d8cC4e02A9A9691Ba0e166b2842360D",
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

function registerSignature(pk, controller, chainId, commitment, isTakeover = false) {
  // Define the input types and values of the transaction data
  const inputTypes = [
    'bytes1',
    'bytes1',
    'address',
    'uint256',
    'bytes32',
    'bytes32',
  ]
  const inputValues = [
    '0x19',
    '0x00',
    controller,
    chainId,
    isTakeover
      ? '0x0548274c4be004976424de9f6f485fbe40a8f13e41524cd574fead54e448415c'
      : '0xdd007bd789f73e08c2714644c55b11c7d202931d717def434e3c9caa12a9f583',
    commitment,
  ]

  // ABI-encode the transaction data
  const digest = ethers.utils.solidityKeccak256(inputTypes, inputValues)

  // console.log(
  //   digest,
  //   controller.address,
  //   network.config.chainId,
  //   isTakeover
  //     ? '0x0548274c4be004976424de9f6f485fbe40a8f13e41524cd574fead54e448415c'
  //     : '0xdd007bd789f73e08c2714644c55b11c7d202931d717def434e3c9caa12a9f583',
  //   commitment,
  // )

  const signingKey = new ethers.utils.SigningKey(pk)
  const signature = signingKey.signDigest(digest)

  return ethers.utils.hexlify(
    ethers.utils.concat([
      signature.r,
      signature.s,
      ethers.utils.hexlify(signature.v),
    ]),
  )
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
    throw new Error('Fetch block error please stop')
  }

  if (!data || !data.length) {
    return CHAIN_CONFIG[chain].startingBlock;
  } else {
    return data[0].block_number;
  }
}

// Update function
async function updateOwner(context: Context, records: RecordUpdate[]) {
  // dirty fix for axl hack
  records = records.filter(x => x.owner != '0xa8815cFdf185b57685680a87BF84005C95ea8b5b')

  for (let record of records) {
    console.log("Update owner", record.node, record.owner);
  }

  let { data: fullRecords, error: fetchError } = await context.supabase
    .from(context.env.DATA_TABLE)
    .select()
    .in('node', records.map(x => x.node))

  if (fetchError) {
    console.error(fetchError)
    return;
  }

  if (!fullRecords || fullRecords.length == 0) {
    return;
  }

  for (let record of fullRecords) {
    const matchedRecord = records.find(x => x.node == record.node && x.chain == record.chain)
    if (matchedRecord) {
      record.owner = matchedRecord.owner;
      record.expiry = matchedRecord.expiry;
    }
  }

  let { data, error } = await context.supabase
    .from(context.env.DATA_TABLE)
    .upsert(fullRecords)
    .select()

  // const { data, error } = await context.supabase.rpc(
  //   "update_many_" + context.env.DATA_TABLE,
  //   {
  //     payload: records.map((record) => ({
  //       ...record,
  //       updated_at: new Date(),
  //     })),
  //   }
  // );

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
      throw new ResponseError(403, "Forbidden");

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

        if (record?.owner.toLowerCase() != body.owner.toLowerCase()) {
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
        body.expiration,
        body.secret,
        body.resolver,
        body.data,
        body.reverseRecord,
        body.ownerControlledFuses
      );

      console.log(context.env.BACKEND_PK)

      return {
        signature: await registerSignature(context.env.BACKEND_PK, chainConfig.registrarControllerAddress, body.chainId, commitment),
      }
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
