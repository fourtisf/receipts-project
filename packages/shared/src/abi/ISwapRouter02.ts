// AUTO-GENERATED from packages/contracts/out/IExternal.sol/ISwapRouter02.json by scripts/gen-abi.mjs — do not edit.
export const swapRouter02Abi = [
  {
    "type": "function",
    "name": "exactInputSingle",
    "inputs": [
      {
        "name": "params",
        "type": "tuple",
        "internalType": "struct ISwapRouter02.ExactInputSingleParams",
        "components": [
          {
            "name": "tokenIn",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "tokenOut",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "fee",
            "type": "uint24",
            "internalType": "uint24"
          },
          {
            "name": "recipient",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "amountIn",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "amountOutMinimum",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "sqrtPriceLimitX96",
            "type": "uint160",
            "internalType": "uint160"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "amountOut",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "payable"
  }
] as const;
