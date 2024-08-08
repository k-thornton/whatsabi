import { addressWithChecksum, fetchJSON } from "./utils.js";
import * as errors from "./errors.js";

export type ContractResult = {
    abi: any[];
    name: string | null;
    evmVersion: string;
    compilerVersion: string;
    runs: number;

    ok: boolean; // False if no result is found

    /**
     * getSources returns the imports -> source code mapping for the contract, if available.
     *
     * Caveats:
     * - Not all loaders support this, so the property could be undefined.
     * - This call could trigger additional fetch requests, depending on the loader.
     **/
    getSources?: () => Promise<ContractSources>;
}

/**
 * ContractSources is a list of source files.
 * If the source was flattened, it will lack a path attribute.
 *
 * @example
 * ```typescript
 * [{"content": "pragma solidity =0.7.6;\n\nimport ..."}]
 * ```
 *
 * @example
 * ```typescript
 * [{"path": "contracts/Foo.sol", "content:" "pragma solidity =0.7.6;\n\nimport ..."}]
 * ```
 **/
export type ContractSources = Array<{ path?: string, content: string }>;


const emptyContractResult: ContractResult = {
    ok: false,

    abi: [],
    name: null,
    evmVersion: "",
    compilerVersion: "",
    runs: 0,
}

export interface ABILoader {
    loadABI(address: string): Promise<any[]>;
    getContract(address: string): Promise<ContractResult>
}

// Load ABIs from multiple providers until a result is found.
export class MultiABILoader implements ABILoader {
    loaders: ABILoader[];

    constructor(loaders: ABILoader[]) {
        this.loaders = loaders;
    }

    async getContract(address: string): Promise<ContractResult> {
        for (const loader of this.loaders) {
            try {
                const r = await loader.getContract(address);
                if (r && r.abi.length > 0) return r;
            } catch (err: any) {
                if (err.status === 404) continue;

                throw new MultiABILoaderError("MultiABILoader getContract error: " + err.message, {
                    context: { loader, address },
                    cause: err,
                });
            }
        }
        return emptyContractResult;
    }

    async loadABI(address: string): Promise<any[]> {
        for (const loader of this.loaders) {
            try {
                const r = await loader.loadABI(address);

                // Return the first non-empty result
                if (r.length > 0) return r;
            } catch (err: any) {
                throw new MultiABILoaderError("MultiABILoader loadABI error: " + err.message, {
                    context: { loader, address },
                    cause: err,
                });
            }
        }
        return [];
    }
}

export class MultiABILoaderError extends errors.LoaderError { };


export class EtherscanABILoader implements ABILoader {
    apiKey?: string;
    baseURL: string;

    constructor(config?: { apiKey?: string, baseURL?: string }) {
        if (config === undefined) config = {};
        this.apiKey = config.apiKey;
        this.baseURL = config.baseURL || "https://api.etherscan.io/api";
    }


    /** Etherscan helper for converting the encoded SourceCode result arg to a decoded ContractSources. */
    #toContractSources(result: { SourceCode: string }): ContractSources {
        if (!result.SourceCode.startsWith("{{")) {
            return [{ content: result.SourceCode }];
        }

        // Etherscan adds an extra {} to the encoded JSON
        const s = JSON.parse(result.SourceCode.slice(1, result.SourceCode.length - 1));

        // Flatten sources
        // { "sources": {"foo.sol": {"content": "..."}}}
        const sources = s.sources as Record<string, { content: string }>;
        return Object.entries(sources).map(
            ([path, source]) => {
                return { path, content: source.content };
            }
        )
    }

    async getContract(address: string): Promise<ContractResult> {
        let url = this.baseURL + '?module=contract&action=getsourcecode&address=' + address;
        if (this.apiKey) url += "&apikey=" + this.apiKey;

        try {
            const r = await fetchJSON(url);
            if (r.status === "0") {
                if (r.result === "Contract source code not verified") return emptyContractResult;
                throw new Error(r.result);    // This gets wrapped below
            }

            const result = r.result[0];
            return {
                abi: JSON.parse(result.ABI),
                name: result.ContractName,
                evmVersion: result.EVMVersion,
                compilerVersion: result.CompilerVersion,
                runs: result.Runs,

                getSources: async () => {
                    try {
                        return this.#toContractSources(result);
                    } catch (err: any) {
                        throw new EtherscanABILoaderError("EtherscanABILoader getContract getSources error: " + err.message, {
                            context: { url, address },
                            cause: err,
                        });
                    }
                },

                ok: true,
            };
        } catch (err: any) {
            throw new EtherscanABILoaderError("EtherscanABILoader getContract error: " + err.message, {
                context: { url, address },
                cause: err,
            });
        }
    }

    async loadABI(address: string): Promise<any[]> {
        let url = this.baseURL + '?module=contract&action=getabi&address=' + address;
        if (this.apiKey) url += "&apikey=" + this.apiKey;

        try {
            const r = await fetchJSON(url);

            if (r.status === "0") {
                if (r.result === "Contract source code not verified") return [];
                throw new Error(r.result); // This gets wrapped below
            }

            return JSON.parse(r.result);

        } catch (err: any) {
            throw new EtherscanABILoaderError("EtherscanABILoader loadABI error: " + err.message, {
                context: { url, address },
                cause: err,
            });
        }
    }
}

export class EtherscanABILoaderError extends errors.LoaderError { };


function isSourcifyNotFound(error: any): boolean {
    return (
        // Sourcify returns strict CORS only if there is no result -_-
        error.message === "Failed to fetch" ||
        error.status === 404
    );
}

// https://sourcify.dev/
export class SourcifyABILoader implements ABILoader {
    chainId?: number;

    constructor(config?: { chainId?: number }) {
        this.chainId = config?.chainId ?? 1;
    }

    static stripPathPrefix(path: string): string {
        return path.replace(/^\/contracts\/(full|partial)_match\/\d*\/\w*\/(sources\/)?/, "");
    }

    async #loadContract(url: string): Promise<ContractResult> {
        try {
            const r = await fetchJSON(url);
            const files : Array<{ name: string, path: string, content: string }> = r.files ?? r;

            // Metadata is usually the first one
            const metadata = files.find((f) => f.name === "metadata.json")
            if (metadata === undefined) throw new SourcifyABILoaderError("metadata.json not found");

            // Note: Sometimes metadata.json contains sources, but not always. So we can't rely on just the metadata.json
            const m = JSON.parse(metadata.content);

            return {
                abi: m.output.abi,
                name: m.output.devdoc?.title ?? null, // Sourcify includes a title from the Natspec comments
                evmVersion: m.settings.evmVersion,
                compilerVersion: m.compiler.version,
                runs: m.settings.optimizer.runs,

                // TODO: Paths will have a sourcify prefix, do we want to strip it to help normalize? It doesn't break anything keeping the prefix, so not sure.
                // E.g. /contracts/full_match/1/0x1F98431c8aD98523631AE4a59f267346ea31F984/sources/contracts/interfaces/IERC20Minimal.sol
                // Can use stripPathPrefix helper to do this, but maybe we want something like getSources({ normalize: true })?
                getSources: async () => files.map(({ path, content }) => { return { path, content } }),

                ok: true,
            };
        } catch (err: any) {
            if (isSourcifyNotFound(err)) return emptyContractResult;
            throw new SourcifyABILoaderError("SourcifyABILoader load contract error: " + err.message, {
                context: { url },
                cause: err,
            });
        }
    }

    async getContract(address: string): Promise<ContractResult> {
        // Sourcify doesn't like it when the address is not checksummed
        address = addressWithChecksum(address);

        {
            // Full match index includes verification settings that matches exactly
            const url = "https://sourcify.dev/server/files/" + this.chainId + "/" + address;
            const r = await this.#loadContract(url);
            if (r.ok) return r;
        }

        {
            // Partial match index is for verified contracts whose settings didn't match exactly
            const url = "https://sourcify.dev/server/files/any/" + this.chainId + "/" + address;
            const r = await this.#loadContract(url);
            if (r.ok) return r;
        }

        return emptyContractResult;
    }

    async loadABI(address: string): Promise<any[]> {
        // Sourcify doesn't like it when the address is not checksummed
        address = addressWithChecksum(address);

        {
            // Full match index includes verification settings that matches exactly
            const url = "https://repo.sourcify.dev/contracts/full_match/" + this.chainId + "/" + address + "/metadata.json";
            try {
                return (await fetchJSON(url)).output.abi;
            } catch (err: any) {
                if (!isSourcifyNotFound(err)) {
                    throw new SourcifyABILoaderError("SourcifyABILoader loadABI error: " + err.message, {
                        context: { address, url },
                        cause: err,
                    });
                }
            }
        }

        {
            // Partial match index is for verified contracts whose settings didn't match exactly
            const url = "https://repo.sourcify.dev/contracts/partial_match/" + this.chainId + "/" + address + "/metadata.json";
            try {
                return (await fetchJSON(url)).output.abi;
            } catch (err: any) {
                if (!isSourcifyNotFound(err)) {
                    throw new SourcifyABILoaderError("SourcifyABILoader loadABI error: " + err.message, {
                        context: { address, url },
                        cause: err,
                    });
                }
            }
        }

        return [];
    }
}

export class SourcifyABILoaderError extends errors.LoaderError { };


export interface SignatureLookup {
    loadFunctions(selector: string): Promise<string[]>;
    loadEvents(hash: string): Promise<string[]>;
}

// Load signatures from multiple providers until a result is found.
export class MultiSignatureLookup implements SignatureLookup {
    lookups: SignatureLookup[];

    constructor(lookups: SignatureLookup[]) {
        this.lookups = lookups;
    }

    async loadFunctions(selector: string): Promise<string[]> {
        for (const lookup of this.lookups) {
            const r = await lookup.loadFunctions(selector);

            // Return the first non-empty result
            if (r.length > 0) return r;
        }
        return [];
    }

    async loadEvents(hash: string): Promise<string[]> {
        for (const lookup of this.lookups) {
            const r = await lookup.loadEvents(hash);

            // Return the first non-empty result
            if (r.length > 0) return r;
        }
        return [];
    }
}

// https://www.4byte.directory/
export class FourByteSignatureLookup implements SignatureLookup {
    async load(url: string): Promise<string[]> {
        try {
            const r = await fetchJSON(url);
            if (r.results === undefined) return [];
            return r.results.map((r: any): string => { return r.text_signature });
        } catch (err: any) {
            if (err.status === 404) return [];
            throw new FourByteSignatureLookupError("FourByteSignatureLookup load error: " + err.message, {
                context: { url },
                cause: err,
            });
        }
    }
    async loadFunctions(selector: string): Promise<string[]> {
        // Note: Could also lookup directly on Github, but not sure that's a good idea
        return this.load("https://www.4byte.directory/api/v1/signatures/?hex_signature=" + selector);
    }

    async loadEvents(hash: string): Promise<string[]> {
        return this.load("https://www.4byte.directory/api/v1/event-signatures/?hex_signature=" + hash);
    }
}

export class FourByteSignatureLookupError extends errors.LoaderError { };

// openchain.xyz
// Formerly: https://sig.eth.samczsun.com/
export class OpenChainSignatureLookup implements SignatureLookup {
    async load(url: string): Promise<any> {
        try {
            const r = await fetchJSON(url);
            if (!r.ok) throw new Error("OpenChain API bad response: " + JSON.stringify(r));
            return r;
        } catch (err: any) {
            if (err.status === 404) return [];
            throw new OpenChainSignatureLookupError("OpenChainSignatureLookup load error: " + err.message, {
                context: { url },
                cause: err,
            });
        }
    }

    async loadFunctions(selector: string): Promise<string[]> {
        const r = await this.load("https://api.openchain.xyz/signature-database/v1/lookup?function=" + selector);
        return (r.result.function[selector] || []).map((item: any) => item.name);
    }

    async loadEvents(hash: string): Promise<string[]> {
        const r = await this.load("https://api.openchain.xyz/signature-database/v1/lookup?event=" + hash);
        return (r.result.event[hash] || []).map((item: any) => item.name);
    }
}

export class OpenChainSignatureLookupError extends errors.LoaderError { };

export class SamczunSignatureLookup extends OpenChainSignatureLookup { }

export const defaultABILoader: ABILoader = new MultiABILoader([new SourcifyABILoader(), new EtherscanABILoader()]);
export const defaultSignatureLookup: SignatureLookup = new MultiSignatureLookup([new OpenChainSignatureLookup(), new FourByteSignatureLookup()]);

type LoaderEnv = {
    ETHERSCAN_API_KEY?: string,
    ETHERSCAN_BASE_URL?: string,
    SOURCIFY_CHAIN_ID?: string | number,
}

/**
 * Return params to use with whatsabi.autoload(...)
 *
 * @example
 * ```ts
 * whatsabi.autoload(address, {provider, ...defaultsWithEnv(process.env)})
 * ```
 *
 * @example
 * ```ts
 * whatsabi.autoload(address, {
 *     provider,
 *     ...defaultsWithEnv({
 *         SOURCIFY_CHAIN_ID: 42161,
 *         ETHERSCAN_BASE_URL: "https://api.arbiscan.io/api",
 *         ETHERSCAN_API_KEY: "MYSECRETAPIKEY",
 *     }),
 * })
 * ```
 */
export function defaultsWithEnv(env: LoaderEnv): Record<string, ABILoader | SignatureLookup> {
    return {
        abiLoader: new MultiABILoader([
            new SourcifyABILoader({ chainId: env.SOURCIFY_CHAIN_ID && Number(env.SOURCIFY_CHAIN_ID) || undefined }),
            new EtherscanABILoader({ apiKey: env.ETHERSCAN_API_KEY, baseURL: env.ETHERSCAN_BASE_URL }),
        ]),
        signatureLookup: new MultiSignatureLookup([
            new OpenChainSignatureLookup(),
            new FourByteSignatureLookup(),
        ]),
    }
}
