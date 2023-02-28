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

export interface Env {
  // Example binding to KV. Learn more at https://developers.cloudflare.com/workers/runtime-apis/kv/
  // OPTIDOMAINS_TESTNET_1: KVNamespace;

  SUPABASE_KEY: string;
  DATA_TABLE: string;

  //
  // Example binding to Durable Object. Learn more at https://developers.cloudflare.com/workers/runtime-apis/durable-objects/
  // MY_DURABLE_OBJECT: DurableObjectNamespace;
  //
  // Example binding to R2. Learn more at https://developers.cloudflare.com/workers/runtime-apis/r2/
  // MY_BUCKET: R2Bucket;
}

const CHAIN_CONFIG = {
  // optimism_goerli: {
  // 	url: `https://goerli.optimism.io`,
  // 	tags: ['test', 'use_root'],
  // 	chainId: 420,
  // 	startingBlock: ,
  // },
  // base_goerli: {
  // 	url: `https://goerli.base.org`,
  // 	tags: ['test', 'use_root'],
  // 	chainId: 84531,
  // 	startingBlock: 	1138000,
  // 	blockLimit: 1000,
  // 	contractAddress: '',
  // },
  'evm_5': {
    url: `https://eth-goerli.g.alchemy.com/v2/Kb0-sSQHUeURzm-QCj-pXKS0Viefa_kX`,
    tags: ["test", "use_root"],
    chainId: 5,
    startingBlock: 8555300,
    blockLimit: 100,
    contractAddress: "0x4a7c7a621834ae33282ae71e403b94ac11024070",
  },
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

  return result.join(".").replace('\0', '');
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
async function getRecord(context: Context, node: string, chain?: string) {
  let promise = context.supabase
    .from(context.env.DATA_TABLE)
    .select("*")
    .eq('node', node)

  if (chain) {
    promise = promise.eq('chain', chain)
  }

	let { data, error } = await promise

	if (error) {
		console.error(error)
	}

	return data
}

async function getRecordByName(context: Context, name: string, chain?: string) {
  let promise = context.supabase
    .from(context.env.DATA_TABLE)
    .select("*")
    .eq('name', name)

  if (chain) {
    promise = promise.eq('chain', chain)
  }

	let { data, error } = await promise

	if (error) {
		console.error(error)
	}

	return data
}

async function getOwnedDomains(context: Context, owner: string, chain?: string) {
  let promise = context.supabase
    .from(context.env.DATA_TABLE)
    .select("*")
    .eq('owner', owner)

  if (chain) {
    promise = promise.eq('chain', chain)
  }

	let { data, error } = await promise

	if (error) {
		console.error(error)
	}

	return data
}

async function getBlockNumber(context: Context, chain: string) {
	let { data, error } = await context.supabase
		.from(context.env.DATA_TABLE + "_blocknumber")
		.select("*")
		.eq('chain', chain)

	if (error) {
		console.error(error)
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
    console.log("Update owner", record.node, record.owner)
  }

  const { data, error } = await context.supabase
    .rpc('update_many_' + context.env.DATA_TABLE, {
      payload: records.map((record) => ({
        ...record,
        updated_at: new Date(),
      }))
    })

	if (error) {
		console.error(error)
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
		console.error(error)
	}
}

async function updateBlockNumber(context: Context, chain: string, blockNumber: number) {
  const { data, error } = await context.supabase
		.from(context.env.DATA_TABLE + "_blocknumber")
    .upsert([
			{
				chain,
				block_number: blockNumber,
				updated_at: new Date(),
			}
		]);

	if (error) {
		console.error(error)
	}
}

async function handleRequest(context: Context, route: string[], body: any) {
  switch (route[0]) {
    case 'node': {
      const node = route[1];
      return await getRecord(context, node, body.chain);
    }

    case 'name': {
      const name = route[1];
      return await getRecordByName(context, name, body.chain);
    }

    case 'owner': {
      const owner = route[1];
      return await getOwnedDomains(context, owner, body.chain);
    }

    case 'commit': {
      // Sign commitment form backend
      if (!body.chain) {
        throw new Error("Chain ID is required")
      }

      break;
    }
  }
}

export default {
  async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext
  ) {
    const { url, method } = request;
    const route = new URL(url).pathname.substring(1).split('/');

    // Create a URLSearchParams object from the request URL's search params
    const searchParams = new URLSearchParams(new URL(url).search)

    // Get an iterator over the search parameters and convert them to an array
    const searchParamsArray = Array.from(searchParams.entries())

    // Convert the array of search parameters to a JSON object using Object.fromEntries()
    const searchParamsJson = Object.fromEntries(searchParamsArray)

    const supabaseUrl = "https://dtdtzmqbttfermhrxnpy.supabase.co";
    const supabaseKey = env.SUPABASE_KEY;
    const supabase = createClient(supabaseUrl, supabaseKey);

		const context: Context = {
			supabase,
			env,
		}

    try {
      if (method == 'POST') {
        const body = await request.json();
  
        return new Response(
          JSON.stringify(
            await handleRequest(context, route, body)
          ),
          {
            headers: {
              'Content-Type': 'application/json'
            }
          }
        )
      } else {
        return new Response(
          JSON.stringify(
            await handleRequest(context, route, searchParamsJson)
          ),
          {
            headers: {
              'Content-Type': 'application/json'
            }
          }
        )
      }
    } catch (err) {
      console.error(err)

      return new Response(
        JSON.stringify({
          message: "Internal server error"
        }),
        {
          headers: {
            'Content-Type': 'application/json'
          },
          status: 500,
        }
      )
    }
    
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
		}

    for (let chainName in CHAIN_CONFIG) {
      const chainConfig = CHAIN_CONFIG[chainName];
      let lastBlockNumber = await getBlockNumber(context, chainName)

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

        const logs = await provider.getLogs(filter)
				const records: Record[] = []

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
					})
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

        const logs = await provider.getLogs(filter)
        const records: RecordUpdate[] = []

				logs.forEach((log) => {
					const parsedLog = iface.parseLog(log);

          if (parsedLog.args.from != "0x0000000000000000000000000000000000000000") {
            records.push({
              chain: chainName,
              node: ethers.utils.hexZeroPad(ethers.utils.hexlify(parsedLog.args.id), 32),
              owner: parsedLog.args.to,
            })
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

        const logs = await provider.getLogs(filter)
        const records: RecordUpdate[] = []

				logs.forEach((log) => {
					const parsedLog = iface.parseLog(log);

          if (parsedLog.args.from != "0x0000000000000000000000000000000000000000") {
            for (let i = 0; i < parsedLog.args.ids.length; i++) {
              records.push({
                chain: chainName,
                node: ethers.utils.hexZeroPad(ethers.utils.hexlify(parsedLog.args.ids[i]), 32),
                owner: parsedLog.args.to,
              })
            }
          }
				});

        if (records.length > 0) {
          await updateOwner(context, records);
        }
      }

      // Update block number forward
      await updateBlockNumber(context, chainName, toBlock)
    }
  },
};
