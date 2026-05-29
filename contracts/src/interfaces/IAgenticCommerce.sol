// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

// Subset of the ERC-8183 reference contract surface the wrapper consumes.
// Deployed at 0x0747EEf0706327138c69792bF28Cd525089e4583 on Arc Testnet.
interface IAgenticCommerce {
    struct Job {
        uint256 id;
        address client;
        address provider;
        address evaluator;
        string  description;
        uint256 budget;
        uint256 expiredAt;
        uint8   status;
        address hook;
    }

    function createJob(
        address provider,
        address evaluator,
        uint256 expiredAt,
        string calldata description,
        address hook
    ) external returns (uint256 jobId);

    function setBudget(uint256 jobId, uint256 amount, bytes calldata optParams) external;
    function fund(uint256 jobId, bytes calldata optParams) external;
    function submit(uint256 jobId, bytes32 deliverable, bytes calldata optParams) external;
    function complete(uint256 jobId, bytes32 reason, bytes calldata optParams) external;
    function reject(uint256 jobId, bytes32 reason, bytes calldata optParams) external;
    function claimRefund(uint256 jobId) external;

    function getJob(uint256 jobId) external view returns (Job memory);
    function jobCounter() external view returns (uint256);
    function paymentToken() external view returns (address);
}
