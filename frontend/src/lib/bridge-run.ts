// Shared types for an in-progress bridge run. Lifted out of the widget so
// the page can pass a single piece of state to both the form (BridgeWidget)
// and a sibling activity panel (BridgeActivity).
import type { BridgeStepName } from './bridge';

export type StepState = 'pending' | 'success' | 'error' | 'noop';

export type StepStatus = {
  state: StepState;
  txHash?: string;
  explorerUrl?: string;
  errorMessage?: string;
};

export type BridgeRun = {
  status: 'idle' | 'running' | 'success' | 'error';
  sourceKey?: import('./bridge').BridgeSource['key'];
  sourceFullName?: string;
  destinationKey?: import('./bridge').BridgeSource['key'];
  destinationFullName?: string;
  amount?: string;
  steps: Partial<Record<BridgeStepName, StepStatus>>;
  errorMessage?: string;
};

export const INITIAL_RUN: BridgeRun = { status: 'idle', steps: {} };
