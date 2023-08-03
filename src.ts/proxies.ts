//import { Provider } from "@ethersproject/abstract-provider";

interface StorageProvider {
    getStorageAt(address: string, slot: number|string, block?: string): Promise<string>
}

interface ProxyResolver {
    resolve(provider: StorageProvider, address: string): Promise<string>

    toString(): string,
}

export const GnosisSafeProxyResolver : ProxyResolver = {
    resolve(provider: StorageProvider, address: string): Promise<string> {
        return provider.getStorageAt(address, 0); // masterCopy() is always first slot
    },

    toString(): string {
        return "GnosisSafeProxy";
    }
}

export const EIP1967ProxyResolver : ProxyResolver = {
    resolve(provider: StorageProvider, address: string): Promise<string> {
        return provider.getStorageAt(address, slots.EIP1967_IMPL);
    },

    toString(): string {
        return "EIP1967Proxy";
    }
}

export const ZeppelinOSProxyResolver : ProxyResolver = {
    resolve(provider: StorageProvider, address: string): Promise<string> {
        return provider.getStorageAt(address, slots.ZEPPELINOS_IMPL);
    },

    toString(): string {
        return "ZeppelinOSProxy";
    }
}

export const PROXIABLEProxyResolver : ProxyResolver = {
    resolve(provider: StorageProvider, address: string): Promise<string> {
        return provider.getStorageAt(address, slots.PROXIABLE);
    },

    toString(): string {
        return "PROXIABLEProxy";
    }
}

// https://github.com/0xsequence/wallet-contracts/blob/master/contracts/Wallet.sol
// Implementation pointer is stored in slot keyed on the deployed address.
export const SequenceWalletProxyResolver : ProxyResolver = {
    resolve(provider: StorageProvider, address: string): Promise<string> {
        return provider.getStorageAt(address, address.toLowerCase().slice(2)).then((r) => {
            // This is going to return 0-padded 32 bytes, need to pull out the 20 bytes at the end.
            return r.slice(26);
        });
    },

    toString(): string {
        return "SequenceWalletProxy";
    }
}


function NotImplemented(name: string) : ProxyResolver {
    return {
        resolve(provider: StorageProvider, address: string): Promise<string> {
            throw "NotImplemented: " + name;
        },

        toString(): string {
            return name;
        }
    }
}

// BYTE32's representing references to known proxy storage slots.
const slots : Record<string, string> = {
    // EIP-1967: Proxy Storage Slots
    // bytes32(uint256(keccak256('eip1967.proxy.implementation')) - 1)
    EIP1967_IMPL: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",

    // EIP-1967
    // Beacon slot is a fallback if implementation is not set.
    // bytes32(uint256(keccak256('eip1967.proxy.beacon')) - 1)).
    // Beacon fallback has selectors:
    // - implementation()
    // - childImplementation()
    // - masterCopy() in Gnosis Safe
    // - comptrollerImplementation() in Compound
    EIP1967_BEACON: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",

    // https://github.com/OpenZeppelin/openzeppelin-labs/blob/54ad91472fdd0ac4c34aa97d3a3da45c28245510/initializer_with_sol_editing/contracts/UpgradeabilityProxy.sol
    // bytes32(uint256(keccak256("org.zeppelinos.proxy.implementation")))
    ZEPPELINOS_IMPL: "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3",

    // ERC-1822: Universal Upgradeable Proxy Standard (UUPS)
    // bytes32(uint256(keccak256("PROXIABLE")))
    PROXIABLE: "0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7",

    // Gnosis Safe Proxy Factor 1.1.1
    // Not actually a slot, but there's a PUSH32 to the masterCopy() selector
    // masterCopy value lives in the 0th slot on the contract
    GNOSIS_SAFE_SELECTOR: "0xa619486e00000000000000000000000000000000000000000000000000000000",

    // EIP-1167 minimal proxy standard
    // Parsed in disasm
}

export const slotResolvers : Record<string, ProxyResolver> = {
    [slots.EIP1967_IMPL]: EIP1967ProxyResolver,
    [slots.EIP1967_BEACON]: NotImplemented("eip1967.proxy.beacon"),
    [slots.ZEPPELINOS_IMPL]: ZeppelinOSProxyResolver,
    [slots.PROXIABLE]: PROXIABLEProxyResolver,
    [slots.GNOSIS_SAFE_SELECTOR]: GnosisSafeProxyResolver,
};
