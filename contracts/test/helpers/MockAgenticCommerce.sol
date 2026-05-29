// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IAgenticCommerce} from "../../src/interfaces/IAgenticCommerce.sol";
import {IERC20} from "../../src/interfaces/IERC20.sol";

// Test double for the ERC-8183 reference contract at 0x0747EEf… on Arc.
// Mirrors the lifecycle the wrapper relies on:
//   - createJob → returns auto-incrementing jobId
//   - setBudget → updates budget on Open job
//   - fund → pulls budget from caller (the wrapper) and holds it
//   - submit → records deliverable hash; Status → Submitted
//   - complete → pays provider the full budget (platformFeeBP = evaluatorFeeBP = 0 in the demo deployment we mirror)
//   - reject → refunds budget to client
//   - claimRefund → refunds budget to client when past deadline
// Mock owns no fee logic of its own — matches the live config where both fee BPs are 0.
contract MockAgenticCommerce is IAgenticCommerce {
    uint8 internal constant STATUS_OPEN      = 0;
    uint8 internal constant STATUS_FUNDED    = 1;
    uint8 internal constant STATUS_SUBMITTED = 2;
    uint8 internal constant STATUS_COMPLETED = 3;
    uint8 internal constant STATUS_REJECTED  = 4;
    uint8 internal constant STATUS_EXPIRED   = 5;

    IERC20 public immutable usdc;
    uint256 public override jobCounter;

    mapping(uint256 => Job) internal _jobs;

    error JobNotFound(uint256 jobId);
    error WrongStatus(uint8 current);
    error PastDeadline(uint256 expiredAt, uint256 nowTs);

    constructor(address usdc_) {
        usdc = IERC20(usdc_);
    }

    function paymentToken() external view returns (address) {
        return address(usdc);
    }

    function createJob(
        address provider,
        address evaluator,
        uint256 expiredAt,
        string calldata description,
        address hook
    ) external returns (uint256 jobId) {
        jobCounter += 1;
        jobId = jobCounter;
        _jobs[jobId] = Job({
            id: jobId,
            client: msg.sender,
            provider: provider,
            evaluator: evaluator,
            description: description,
            budget: 0,
            expiredAt: expiredAt,
            status: STATUS_OPEN,
            hook: hook
        });
    }

    function setBudget(uint256 jobId, uint256 amount, bytes calldata) external {
        Job storage j = _jobs[jobId];
        if (j.client == address(0)) revert JobNotFound(jobId);
        if (j.status != STATUS_OPEN) revert WrongStatus(j.status);
        j.budget = amount;
    }

    function fund(uint256 jobId, bytes calldata) external {
        Job storage j = _jobs[jobId];
        if (j.client == address(0)) revert JobNotFound(jobId);
        if (j.status != STATUS_OPEN) revert WrongStatus(j.status);
        if (block.timestamp > j.expiredAt) revert PastDeadline(j.expiredAt, block.timestamp);
        usdc.transferFrom(msg.sender, address(this), j.budget);
        j.status = STATUS_FUNDED;
    }

    function submit(uint256 jobId, bytes32, bytes calldata) external {
        Job storage j = _jobs[jobId];
        if (j.client == address(0)) revert JobNotFound(jobId);
        if (j.status != STATUS_FUNDED) revert WrongStatus(j.status);
        j.status = STATUS_SUBMITTED;
    }

    function complete(uint256 jobId, bytes32, bytes calldata) external {
        Job storage j = _jobs[jobId];
        if (j.client == address(0)) revert JobNotFound(jobId);
        if (j.status != STATUS_SUBMITTED) revert WrongStatus(j.status);
        usdc.transfer(j.provider, j.budget);
        j.status = STATUS_COMPLETED;
    }

    function reject(uint256 jobId, bytes32, bytes calldata) external {
        Job storage j = _jobs[jobId];
        if (j.client == address(0)) revert JobNotFound(jobId);
        if (j.status != STATUS_OPEN && j.status != STATUS_FUNDED && j.status != STATUS_SUBMITTED) {
            revert WrongStatus(j.status);
        }
        if (j.status == STATUS_FUNDED || j.status == STATUS_SUBMITTED) {
            usdc.transfer(j.client, j.budget);
        }
        j.status = STATUS_REJECTED;
    }

    function claimRefund(uint256 jobId) external {
        Job storage j = _jobs[jobId];
        if (j.client == address(0)) revert JobNotFound(jobId);
        if (j.status != STATUS_FUNDED && j.status != STATUS_SUBMITTED) revert WrongStatus(j.status);
        if (block.timestamp <= j.expiredAt) revert PastDeadline(j.expiredAt, block.timestamp);
        usdc.transfer(j.client, j.budget);
        j.status = STATUS_EXPIRED;
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        if (_jobs[jobId].client == address(0)) revert JobNotFound(jobId);
        return _jobs[jobId];
    }
}
