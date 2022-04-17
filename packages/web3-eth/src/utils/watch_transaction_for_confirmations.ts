import {
	BlockOutput,
	DataFormat,
	EthExecutionAPI,
	format,
	PromiEvent,
	Web3BaseProvider,
} from 'web3-common';
import { Web3Context } from 'web3-core';
import { Bytes, HexString32Bytes, numberToHex } from 'web3-utils';

import {
	TransactionMissingReceiptOrBlockHashError,
	TransactionReceiptMissingBlockNumberError,
} from '../errors';
import { ReceiptInfo, SendSignedTransactionEvents, SendTransactionEvents } from '../types';
import { getBlockByNumber } from '../rpc_methods';
import { NewHeadsSubscription } from '../web3_subscriptions';

type PromiEventEventTypeBase = SendTransactionEvents | SendSignedTransactionEvents;
type ReturnFormatBase = DataFormat;
type WaitByPollingProps = {
	web3Context: Web3Context<EthExecutionAPI>;
	transactionReceipt: ReceiptInfo;
	transactionPromiEvent: PromiEvent<ReceiptInfo, PromiEventEventTypeBase>;
	returnFormat: ReturnFormatBase;
};
const waitByPolling = ({
	web3Context,
	transactionReceipt,
	transactionPromiEvent,
	returnFormat,
}: WaitByPollingProps) => {
	// Having a transactionReceipt means that the transaction has already been included
	// in at least one block, so we start with 1
	let confirmationNumber = 1;
	const intervalId = setInterval(() => {
		(async () => {
			if (confirmationNumber >= web3Context.transactionConfirmationBlocks)
				clearInterval(intervalId);

			const nextBlock = await getBlockByNumber(
				web3Context.requestManager,
				numberToHex(BigInt(transactionReceipt.blockNumber) + BigInt(confirmationNumber)),
				false,
			);

			if (nextBlock?.hash !== null) {
				confirmationNumber += 1;
				transactionPromiEvent.emit('confirmation', {
					confirmationNumber: format({ eth: 'uint' }, confirmationNumber, returnFormat),
					receipt: transactionReceipt,
					latestBlockHash: format({ eth: 'bytes32' }, nextBlock.hash, returnFormat),
				});
			}
		})() as unknown;
	}, web3Context.transactionReceiptPollingInterval ?? web3Context.transactionPollingInterval);
};

export function watchTransactionForConfirmations<
	PromiEventEventType extends PromiEventEventTypeBase,
	ReturnFormat extends ReturnFormatBase,
>(
	web3Context: Web3Context<EthExecutionAPI>,
	transactionPromiEvent: PromiEvent<ReceiptInfo, PromiEventEventType>,
	transactionReceipt: ReceiptInfo,
	transactionHash: Bytes,
	returnFormat: ReturnFormat,
) {
	if (
		transactionReceipt === undefined ||
		transactionReceipt === null ||
		transactionReceipt.blockHash === undefined ||
		transactionReceipt.blockHash === null
	)
		throw new TransactionMissingReceiptOrBlockHashError({
			receipt: transactionReceipt,
			blockHash: format({ eth: 'bytes32' }, transactionReceipt.blockHash, returnFormat),
			transactionHash: format({ eth: 'bytes32' }, transactionHash, returnFormat),
		});

	if (transactionReceipt.blockNumber === undefined || transactionReceipt.blockNumber === null)
		throw new TransactionReceiptMissingBlockNumberError({ receipt: transactionReceipt });

	// so a subscription for newBlockHeaders can be made instead of polling
	const provider: Web3BaseProvider = web3Context.requestManager.provider as Web3BaseProvider;
	if (provider.supportsSubscriptions()) {
		setImmediate(() => {
			web3Context.subscriptionManager
				?.subscribe('newHeads')
				.then((subscription: NewHeadsSubscription) => {
					subscription.on('data', async (data: BlockOutput) => {
						const confirmationNumber = 1;
						if (
							data.number ===
							BigInt(transactionReceipt.blockNumber) + BigInt(confirmationNumber)
						) {
							transactionPromiEvent.emit('confirmation', {
								confirmationNumber: format(
									{ eth: 'uint' },
									confirmationNumber + 1,
									returnFormat,
								),
								receipt: transactionReceipt,
								latestBlockHash: format(
									{ eth: 'bytes32' },
									data.parentHash as HexString32Bytes,
									returnFormat,
								),
							});
							await subscription.unsubscribe();
						}
					});
					subscription.on('error', () => {
						waitByPolling({
							web3Context,
							transactionReceipt,
							transactionPromiEvent,
							returnFormat,
						});
					});
				})
				.catch(() => {
					waitByPolling({
						web3Context,
						transactionReceipt,
						transactionPromiEvent,
						returnFormat,
					});
				});
		});
	} else {
		waitByPolling({ web3Context, transactionReceipt, transactionPromiEvent, returnFormat });
	}
}
