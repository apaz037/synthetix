const { artifacts, contract, web3 } = require('@nomiclabs/buidler');
const { assert } = require('./common');
const { onlyGivenAddressCanInvoke, ensureOnlyExpectedMutativeFunctions } = require('./helpers');
const { addSnapshotBeforeRestoreAfter } = require('./common');
const { mockToken, mockGenericContractFnc } = require('./setup');
const { toWei } = web3.utils;
const BN = require('bn.js');

const SecondaryDeposit = artifacts.require('SecondaryDeposit');
const FakeSecondaryDeposit = artifacts.require('FakeSecondaryDeposit');

contract('SecondaryDeposit (unit tests)', accounts => {
	const [deployerAccount, owner, companion, migratedDeposit, account1, account2] = accounts;

	const mockTokenTotalSupply = '1000000';
	const mockAddress = '0x0000000000000000000000000000000000000001';
	const maxDeposit = toWei('5000');

	it('ensure only known functions are mutative', () => {
		ensureOnlyExpectedMutativeFunctions({
			abi: SecondaryDeposit.abi,
			ignoreParents: ['Owned', 'MixinResolver', 'MixinSystemSettings'],
			expected: [
				'deposit',
				'completeWithdrawal',
				'migrateDeposit',
			],
		});
	});

	describe('when deploying a mock token', () => {
		before('deploy mock token', async () => {
			({ token: this.token } = await mockToken({
				accounts,
				name: 'Mock Token',
				symbol: 'MCK',
				supply: mockTokenTotalSupply,
			}));
			// transfer 100 tokens to account1
			await this.token.transfer(account1, 100, { from: owner });
		});

		it('has the expected parameters', async () => {
			assert.equal('18', await this.token.decimals());
			assert.equal(toWei(mockTokenTotalSupply), await this.token.totalSupply());
			assert.bnEqual(
				(await this.token.totalSupply()).sub(new BN(100)),
				await this.token.balanceOf(owner)
			);
			assert.equal(100, await this.token.balanceOf(account1));
		});

		describe('when mocks for Issuer and resolver are added', () => {
			before('deploy a mock issuer contract', async () => {
				this.issuerMock = await artifacts.require('GenericMock').new();

				// now instruct the mock Issuer that debtBalanceOf() must return 0
				await mockGenericContractFnc({
					instance: this.issuerMock,
					mock: 'Issuer',
					fncName: 'debtBalanceOf',
					returns: [0],
				});

				this.resolverMock = await artifacts.require('GenericMock').new();
				// now instruct the mock AddressResolver that getAddress() must return a mock addresss
				await mockGenericContractFnc({
					instance: this.resolverMock,
					mock: 'AddressResolver',
					fncName: 'getAddress',
					returns: [mockAddress],
				});

				this.mintableSynthetixMock = await artifacts.require('FakeMintableSynthetix').new();
			});

			it('mocked contracs are deployed', async () => {
				assert.notEqual(this.resolverMock.address, this.issuerMock.address);
			});

			describe('when a FakeSecondaryDeposit contract is deployed', () => {
				before('deploy deposit contract', async () => {
					this.secondaryDeposit = await FakeSecondaryDeposit.new(
						owner,
						this.resolverMock.address,
						this.token.address,
						this.mintableSynthetixMock.address,
						this.issuerMock.address,
						companion,
						{
							from: deployerAccount,
						}
					);
				});

				before('connect to CrossDomainMessengerMock', async () => {
					const crossDomainMessengerMock = await artifacts.require('CrossDomainMessengerMock');
					const currentAddress = await this.secondaryDeposit.crossDomainMessengerMock();
					this.messengerMock = await crossDomainMessengerMock.at(currentAddress);
				});

				it('has the expected parameters', async () => {
					assert.bnEqual(await this.secondaryDeposit.maximumDeposit(), maxDeposit);
					assert.equal(true, await this.secondaryDeposit.activated());
					assert.equal(owner, await this.secondaryDeposit.owner());
					assert.equal(this.resolverMock.address, await this.secondaryDeposit.resolver());
					assert.equal(companion, await this.secondaryDeposit.xChainCompanion());
				});

				describe('deposit calling CrossDomainMessenger.sendMessage', () => {
					addSnapshotBeforeRestoreAfter();

					const amount = 100;

					before('make a deposit', async () => {
						await this.token.approve(this.secondaryDeposit.address, amount, { from: account1 });
						await this.secondaryDeposit.deposit(amount, { from: account1 });
					});

					it('called sendMessage with the expected target address', async () => {
						assert.equal(
							await this.messengerMock.sendMessageCallTarget(),
							await this.secondaryDeposit.xChainCompanion()
						);
					});

					it('called sendMessage with the expected gasLimit', async () => {
						assert.equal(await this.messengerMock.sendMessageCallGasLimit(), 3e6);
					});

					// it('called sendMessage with the expected message', async () => {
					// 	assert.equal(
					// 		await this.messengerMock.sendMessageCallMessage(),
					// 		this.secondaryDeposit.contract.methods
					// 			.mintSecondaryFromDeposit(account1, amount)
					// 			.encodeABI()
					// 	);
					// });
				});

				describe('a user tries to deposit an amount above the max limit', () => {
					it('should revert', async () => {
						const exceedMaxDeposit = (await this.secondaryDeposit.maximumDeposit()).add(new BN(1));
						await assert.revert(
							this.secondaryDeposit.deposit(exceedMaxDeposit, { from: owner }),
							'Cannot deposit more than the max'
						);
					});
				});

				describe('a user tries to deposit but has non-zero debt', () => {
					let secondaryDeposit;
					before('deploy deposit contract', async () => {
						const issuerMock = await artifacts.require('GenericMock').new();

						// now instruct the mock Issuer that debtBalanceOf() must return 0
						await mockGenericContractFnc({
							instance: issuerMock,
							mock: 'Issuer',
							fncName: 'debtBalanceOf',
							returns: [1],
						});

						secondaryDeposit = await FakeSecondaryDeposit.new(
							owner,
							this.resolverMock.address,
							this.token.address,
							this.mintableSynthetixMock.address,
							issuerMock.address,
							companion,
							{
								from: deployerAccount,
							}
						);
					});

					it('should revert', async () => {
						await assert.revert(
							secondaryDeposit.deposit(100, { from: account1 }),
							'Cannot deposit with debt'
						);
					});
				});

				describe('a user tries to deposit within the max limit', () => {
					let depositTx;

					before('user approves and deposits 100 tokens', async () => {
						await this.token.approve(this.secondaryDeposit.address, 100, { from: account1 });
						depositTx = await this.secondaryDeposit.deposit(100, { from: account1 });
					});

					it('tranfers the tokens to the deposit contract', async () => {
						assert.equal(100, await this.token.balanceOf(this.secondaryDeposit.address));
						assert.equal(0, await this.token.balanceOf(account1));
					});

					it('should emit a Deposit event', async () => {
						assert.eventEqual(depositTx, 'Deposit', {
							account: account1,
							amount: 100,
						});
					});
				});

				describe('when completeWithdrawal() is invoked by its companion (alt:SecondaryDeposit)', async () => {
					let completeWithdrawalTx;
					const withdrawalAmount = 100;

					before('user has deposited before withdrawing', async () => {
						await this.token.transfer(account2, 100, { from: owner });
						await this.token.approve(this.secondaryDeposit.address, 100, { from: account2 });
						depositTx = await this.secondaryDeposit.deposit(100, { from: account2 });

						completeWithdrawalTx = await this.messengerMock.completeWithdrawal(
							this.secondaryDeposit.address,
							account2,
							withdrawalAmount
						);
					});

					it('should transfer the right amount to the withdrawal address', async () => {
						assert.equal(withdrawalAmount, await this.token.balanceOf(account2));
					});

					it('should emit a WithdrawalCompleted event', async () => {
						assert.eventEqual(completeWithdrawalTx, 'WithdrawalCompleted', {
							account: account2,
							amount: withdrawalAmount,
						});
					});

				});
				
				describe('when migrateDeposit is called by the owner', async () => {
					let migrateDepositTx;

					before('migrateDeposit is called', async () => {
						migrateDepositTx = await this.secondaryDeposit.migrateDeposit(migratedDeposit, {
							from: owner,
						});
					});

					it('should update the token balances', async () => {
						assert.equal('0', await this.token.balanceOf(this.secondaryDeposit.address));
						assert.equal('100', await this.token.balanceOf(migratedDeposit));
					});

					it('should deactivate the deposit functionality', async () => {
						assert.equal(false, await this.secondaryDeposit.activated());
						await assert.revert(
							this.secondaryDeposit.deposit(100, { from: account1 }),
							'Function deactivated'
						);
					});

					it('should emit a MintedSecondary event', async () => {
						assert.eventEqual(migrateDepositTx, 'DepositMigrated', {
							oldDeposit: this.secondaryDeposit.address,
							newDeposit: migratedDeposit,
							amount: 100,
						});
					});
				});
				
				describe('modifiers and access permissions', async () => {
					it('should only allow the onwer to call migrateDeposit()', async () => {
						await onlyGivenAddressCanInvoke({
							fnc: this.secondaryDeposit.migrateDeposit,
							args: [account1],
							address: owner,
							accounts,
							reason: 'Only the contract owner may perform this action',
						});
					});
				});
				
			});
		});
	});
});
