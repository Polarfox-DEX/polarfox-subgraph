/* eslint-disable prefer-const */
import { BigInt, BigDecimal, store, Address } from '@graphprotocol/graph-ts'
import {
  Pair,
  Token,
  PolarfoxFactory,
  Transaction,
  Mint as MintEvent,
  Burn as BurnEvent,
  Swap as SwapEvent,
  Bundle,
  LiquidityPosition
} from '../types/schema'
import { Pair as PairContract, Mint, Burn, Swap, Transfer, Sync } from '../types/templates/Pair/Pair'
import { updatePairDayData, updateTokenDayData, updatePolarfoxDayData, updatePairHourData } from './dayUpdates'
import { getAvaxPriceInUSD, findAvaxPerToken, getTrackedVolumeUSD, getTrackedLiquidityUSD } from './pricing'
import {
  convertTokenToDecimal,
  ADDRESS_ZERO,
  FACTORY_ADDRESS,
  ROUTER_ADDRESS,
  ONE_BI,
  createUser,
  createLiquidityPosition,
  ZERO_BD,
  BI_18,
  createLiquiditySnapshot
} from './helpers'

let MINING_POOLS: string[] = [
  '0xa1ae93d4c9c4271297653cf654d0b4d5105d8251', // v1 PFX/AVAX → PFX
  '0xcfb90b451d0f2ff417820d3a79b95f12ee001e03', // v1 PFX/WETH → PFX
  '0x25a3887a3faf119aa6420268305db0aafbe31b12', // v1 PFX/USDT → PFX
  '0x3e6b8a36bf6de077bbba89d93f3cd6b7dba6acc4', // v1 AVAX/WETH → PFX
  '0xc1ddc5a427465ffb913cf247a92dde84443a252d', // v1 AVAX/USDT → PFX

  '0xcb9bd879f44b00b3223ebc2347aa7c97b470c3a5', // v1 AKITA/PFX → gAKITA
  '0x0a6e5bfe21b7612f1841e4956e7964a8ae8380e7' // v1 AKITA/AVAX → gAKITA
]

function isCompleteMint(mintId: string): boolean {
  return MintEvent.load(mintId).sender !== null // sufficient checks
}

export function handleTransfer(event: Transfer): void {
  // ignore initial transfers for first adds
  if (event.params.to.toHexString() == ADDRESS_ZERO && event.params.value.equals(BigInt.fromI32(1000))) {
    return
  }

  // skip if staking/unstaking
  if (MINING_POOLS.includes(event.params.from.toHexString()) || MINING_POOLS.includes(event.params.to.toHexString())) {
    return
  }

  let factory = PolarfoxFactory.load(FACTORY_ADDRESS)
  let transactionHash = event.transaction.hash.toHexString()

  // user stats
  let from = event.params.from
  createUser(from)
  let to = event.params.to
  createUser(to)

  // get pair and load contract
  let pair = Pair.load(event.address.toHexString())
  let pairContract = PairContract.bind(event.address)

  // liquidity token amount being transfered
  let value = convertTokenToDecimal(event.params.value, BI_18)

  // get or create transaction
  let transaction = Transaction.load(transactionHash)
  if (transaction === null) {
    transaction = new Transaction(transactionHash)
    transaction.blockNumber = event.block.number
    transaction.timestamp = event.block.timestamp
    transaction.mints = []
    transaction.burns = []
    transaction.swaps = []
  }

  // mints
  let mints = transaction.mints
  if (from.toHexString() == ADDRESS_ZERO) {
    // update total supply
    pair.totalSupply = pair.totalSupply.plus(value)
    pair.save()

    // create new mint if no mints so far or if last one is done already
    if (mints.length === 0 || isCompleteMint(mints[mints.length - 1])) {
      let mint = new MintEvent(
        event.transaction.hash
          .toHexString()
          .concat('-')
          .concat(BigInt.fromI32(mints.length).toString())
      )
      mint.transaction = transaction.id
      mint.pair = pair.id
      mint.to = to
      mint.liquidity = value
      mint.timestamp = transaction.timestamp
      mint.transaction = transaction.id
      mint.save()

      // update mints in transaction
      transaction.mints = mints.concat([mint.id])

      // save entities
      transaction.save()
      factory.save()
    }
  }

  // case where direct send first on AVAX withdrawls
  if (event.params.to.toHexString() == pair.id) {
    let burns = transaction.burns
    let burn = new BurnEvent(
      event.transaction.hash
        .toHexString()
        .concat('-')
        .concat(BigInt.fromI32(burns.length).toString())
    )
    burn.transaction = transaction.id
    burn.pair = pair.id
    burn.liquidity = value
    burn.timestamp = transaction.timestamp
    burn.to = event.params.to
    burn.sender = event.params.from
    burn.needsComplete = true
    burn.transaction = transaction.id
    burn.save()

    // TODO: Consider using .concat() for handling array updates to protect
    // against unintended side effects for other code paths.
    burns.push(burn.id)
    transaction.burns = burns
    transaction.save()
  }

  // burn
  if (event.params.to.toHexString() == ADDRESS_ZERO && event.params.from.toHexString() == pair.id) {
    pair.totalSupply = pair.totalSupply.minus(value)
    pair.save()

    // this is a new instance of a logical burn
    let burns = transaction.burns
    let burn: BurnEvent
    if (burns.length > 0) {
      let currentBurn = BurnEvent.load(burns[burns.length - 1])
      if (currentBurn.needsComplete) {
        burn = currentBurn as BurnEvent
      } else {
        burn = new BurnEvent(
          event.transaction.hash
            .toHexString()
            .concat('-')
            .concat(BigInt.fromI32(burns.length).toString())
        )
        burn.transaction = transaction.id
        burn.needsComplete = false
        burn.pair = pair.id
        burn.liquidity = value
        burn.transaction = transaction.id
        burn.timestamp = transaction.timestamp
      }
    } else {
      burn = new BurnEvent(
        event.transaction.hash
          .toHexString()
          .concat('-')
          .concat(BigInt.fromI32(burns.length).toString())
      )
      burn.transaction = transaction.id
      burn.needsComplete = false
      burn.pair = pair.id
      burn.liquidity = value
      burn.transaction = transaction.id
      burn.timestamp = transaction.timestamp
    }

    // if this logical burn included a fee mint, account for this
    if (mints.length !== 0 && !isCompleteMint(mints[mints.length - 1])) {
      let mint = MintEvent.load(mints[mints.length - 1])
      burn.feeTo = mint.to
      burn.feeLiquidity = mint.liquidity
      // remove the logical mint
      store.remove('Mint', mints[mints.length - 1])
      // update the transaction

      // TODO: Consider using .slice().pop() to protect against unintended
      // side effects for other code paths.
      mints.pop()
      transaction.mints = mints
      transaction.save()
    }
    burn.save()
    // if accessing last one, replace it
    if (burn.needsComplete) {
      // TODO: Consider using .slice(0, -1).concat() to protect against
      // unintended side effects for other code paths.
      burns[burns.length - 1] = burn.id
    }
    // else add new one
    else {
      // TODO: Consider using .concat() for handling array updates to protect
      // against unintended side effects for other code paths.
      burns.push(burn.id)
    }
    transaction.burns = burns
    transaction.save()
  }

  if (from.toHexString() != ADDRESS_ZERO && from.toHexString() != pair.id) {
    let fromUserLiquidityPosition = createLiquidityPosition(event.address, from)
    fromUserLiquidityPosition.liquidityTokenBalance = fromUserLiquidityPosition.liquidityTokenBalance.minus(
      convertTokenToDecimal(event.params.value, BI_18)
    )
    fromUserLiquidityPosition.save()
    createLiquiditySnapshot(fromUserLiquidityPosition, event)
  }

  if (event.params.to.toHexString() != ADDRESS_ZERO && to.toHexString() != pair.id) {
    let toUserLiquidityPosition = createLiquidityPosition(event.address, to)
    toUserLiquidityPosition.liquidityTokenBalance = toUserLiquidityPosition.liquidityTokenBalance.plus(
      convertTokenToDecimal(event.params.value, BI_18)
    )
    toUserLiquidityPosition.save()
    createLiquiditySnapshot(toUserLiquidityPosition, event)
  }

  transaction.save()
}

export function handleSync(event: Sync): void {
  let pair = Pair.load(event.address.toHex())
  let token0 = Token.load(pair.token0)
  let token1 = Token.load(pair.token1)
  let polarfox = PolarfoxFactory.load(FACTORY_ADDRESS)

  // reset factory liquidity by subtracting only tracked liquidity
  polarfox.totalLiquidityAVAX = polarfox.totalLiquidityAVAX.minus(pair.trackedReserveAVAX as BigDecimal)

  // reset token total liquidity amounts
  token0.totalLiquidity = token0.totalLiquidity.minus(pair.reserve0)
  token1.totalLiquidity = token1.totalLiquidity.minus(pair.reserve1)

  pair.reserve0 = convertTokenToDecimal(event.params.reserve0, token0.decimals)
  pair.reserve1 = convertTokenToDecimal(event.params.reserve1, token1.decimals)

  if (pair.reserve1.notEqual(ZERO_BD)) pair.token0Price = pair.reserve0.div(pair.reserve1)
  else pair.token0Price = ZERO_BD
  if (pair.reserve0.notEqual(ZERO_BD)) pair.token1Price = pair.reserve1.div(pair.reserve0)
  else pair.token1Price = ZERO_BD

  pair.save()

  // update AVAX price now that reserves could have changed
  let bundle = Bundle.load('1')
  bundle.avaxPrice = getAvaxPriceInUSD()
  bundle.save()

  token0.derivedAVAX = findAvaxPerToken(token0 as Token)
  token1.derivedAVAX = findAvaxPerToken(token1 as Token)
  token0.save()
  token1.save()

  // get tracked liquidity - will be 0 if neither is in whitelist
  let trackedLiquidityAVAX: BigDecimal
  if (bundle.avaxPrice.notEqual(ZERO_BD)) {
    trackedLiquidityAVAX = getTrackedLiquidityUSD(pair.reserve0, token0 as Token, pair.reserve1, token1 as Token).div(bundle.avaxPrice)
  } else {
    trackedLiquidityAVAX = ZERO_BD
  }

  // use derived amounts within pair
  pair.trackedReserveAVAX = trackedLiquidityAVAX
  pair.reserveAVAX = pair.reserve0.times(token0.derivedAVAX as BigDecimal).plus(pair.reserve1.times(token1.derivedAVAX as BigDecimal))
  pair.reserveUSD = pair.reserveAVAX.times(bundle.avaxPrice)

  // use tracked amounts globally
  polarfox.totalLiquidityAVAX = polarfox.totalLiquidityAVAX.plus(trackedLiquidityAVAX)
  polarfox.totalLiquidityUSD = polarfox.totalLiquidityAVAX.times(bundle.avaxPrice)

  // now correctly set liquidity amounts for each token
  token0.totalLiquidity = token0.totalLiquidity.plus(pair.reserve0)
  token1.totalLiquidity = token1.totalLiquidity.plus(pair.reserve1)

  // save entities
  pair.save()
  polarfox.save()
  token0.save()
  token1.save()
}

export function handleMint(event: Mint): void {
  let transaction = Transaction.load(event.transaction.hash.toHexString())
  let mints = transaction.mints
  let mint = MintEvent.load(mints[mints.length - 1])

  let pair = Pair.load(event.address.toHex())
  let polarfox = PolarfoxFactory.load(FACTORY_ADDRESS)

  let token0 = Token.load(pair.token0)
  let token1 = Token.load(pair.token1)

  // update exchange info (except balances, sync will cover that)
  let token0Amount = convertTokenToDecimal(event.params.amount0, token0.decimals)
  let token1Amount = convertTokenToDecimal(event.params.amount1, token1.decimals)

  // update txn counts
  token0.txCount = token0.txCount.plus(ONE_BI)
  token1.txCount = token1.txCount.plus(ONE_BI)

  // get new amounts of USD and AVAX for tracking
  let bundle = Bundle.load('1')
  let amountTotalAVAX = token1.derivedAVAX
    .times(token1Amount)
    .plus(token0.derivedAVAX.times(token0Amount))
  let amountTotalUSD = amountTotalAVAX
    .times(bundle.avaxPrice)

  // update txn counts
  pair.txCount = pair.txCount.plus(ONE_BI)
  polarfox.txCount = polarfox.txCount.plus(ONE_BI)

  // save entities
  token0.save()
  token1.save()
  pair.save()
  polarfox.save()

  mint.sender = event.params.sender
  mint.amount0 = token0Amount as BigDecimal
  mint.amount1 = token1Amount as BigDecimal
  mint.logIndex = event.logIndex
  mint.amountAVAX = amountTotalAVAX as BigDecimal
  mint.amountUSD = amountTotalUSD as BigDecimal
  mint.save()

  // update the LP position
  let liquidityPosition = createLiquidityPosition(event.address, mint.to as Address)
  createLiquiditySnapshot(liquidityPosition, event)

  // update day entities
  updatePairDayData(event)
  updatePairHourData(event)
  updatePolarfoxDayData(event)
  updateTokenDayData(token0 as Token, event)
  updateTokenDayData(token1 as Token, event)
}

export function handleBurn(event: Burn): void {
  let transaction = Transaction.load(event.transaction.hash.toHexString())

  // safety check
  if (transaction === null) {
    return
  }

  let burns = transaction.burns
  let burn = BurnEvent.load(burns[burns.length - 1])

  let pair = Pair.load(event.address.toHex())
  let polarfox = PolarfoxFactory.load(FACTORY_ADDRESS)

  //update token info
  let token0 = Token.load(pair.token0)
  let token1 = Token.load(pair.token1)
  let token0Amount = convertTokenToDecimal(event.params.amount0, token0.decimals)
  let token1Amount = convertTokenToDecimal(event.params.amount1, token1.decimals)

  // update txn counts
  token0.txCount = token0.txCount.plus(ONE_BI)
  token1.txCount = token1.txCount.plus(ONE_BI)

  // get new amounts of USD and AVAX for tracking
  let bundle = Bundle.load('1')
  let amountTotalAVAX = token1.derivedAVAX
    .times(token1Amount)
    .plus(token0.derivedAVAX.times(token0Amount))
  let amountTotalUSD = amountTotalAVAX
    .times(bundle.avaxPrice)

  // update txn counts
  polarfox.txCount = polarfox.txCount.plus(ONE_BI)
  pair.txCount = pair.txCount.plus(ONE_BI)

  // update global counter and save
  token0.save()
  token1.save()
  pair.save()
  polarfox.save()

  // update burn
  // burn.sender = event.params.sender
  burn.amount0 = token0Amount as BigDecimal
  burn.amount1 = token1Amount as BigDecimal
  // burn.to = event.params.to
  burn.logIndex = event.logIndex
  burn.amountAVAX = amountTotalAVAX as BigDecimal
  burn.amountUSD = amountTotalUSD as BigDecimal
  burn.save()

  // update the LP position
  let liquidityPosition = createLiquidityPosition(event.address, burn.sender as Address)
  createLiquiditySnapshot(liquidityPosition, event)

  // update day entities
  updatePairDayData(event)
  updatePairHourData(event)
  updatePolarfoxDayData(event)
  updateTokenDayData(token0 as Token, event)
  updateTokenDayData(token1 as Token, event)
}

export function handleSwap(event: Swap): void {
  // check if sender and dest are equal to the router
  // if so, change the to address to the tx issuer
  let dest: Address
  if (event.params.sender == Address.fromString(ROUTER_ADDRESS) && event.params.to == Address.fromString(ROUTER_ADDRESS)) {
    dest = event.transaction.from
  } else {
    dest = event.params.to
  }

  let pair = Pair.load(event.address.toHexString())
  let token0 = Token.load(pair.token0)
  let token1 = Token.load(pair.token1)
  let amount0In = convertTokenToDecimal(event.params.amount0In, token0.decimals)
  let amount1In = convertTokenToDecimal(event.params.amount1In, token1.decimals)
  let amount0Out = convertTokenToDecimal(event.params.amount0Out, token0.decimals)
  let amount1Out = convertTokenToDecimal(event.params.amount1Out, token1.decimals)

  // totals for volume updates
  let amount0Total = amount0Out.plus(amount0In)
  let amount1Total = amount1Out.plus(amount1In)

  // AVAX/USD prices
  let bundle = Bundle.load('1')

  // get total amounts of derived USD and AVAX for tracking
  let derivedAmountAVAX = token1.derivedAVAX
    .times(amount1Total)
    .plus(token0.derivedAVAX.times(amount0Total))
    .div(BigDecimal.fromString('2'))
  let derivedAmountUSD = derivedAmountAVAX.times(bundle.avaxPrice)

  // only accounts for volume through white listed tokens
  let trackedAmountUSD = getTrackedVolumeUSD(amount0Total, token0 as Token, amount1Total, token1 as Token, pair as Pair)

  let trackedAmountAVAX: BigDecimal
  if (bundle.avaxPrice.equals(ZERO_BD)) {
    trackedAmountAVAX = ZERO_BD
  } else {
    trackedAmountAVAX = trackedAmountUSD.div(bundle.avaxPrice)
  }

  // update token0 global volume and token liquidity stats
  token0.tradeVolume = token0.tradeVolume.plus(amount0In.plus(amount0Out))
  token0.tradeVolumeAVAX = token0.tradeVolumeAVAX.plus(trackedAmountAVAX)
  token0.tradeVolumeUSD = token0.tradeVolumeUSD.plus(trackedAmountUSD)
  token0.untrackedVolumeAVAX = token0.untrackedVolumeAVAX.plus(derivedAmountAVAX)
  token0.untrackedVolumeUSD = token0.untrackedVolumeUSD.plus(derivedAmountUSD)

  // update token1 global volume and token liquidity stats
  token1.tradeVolume = token1.tradeVolume.plus(amount1In.plus(amount1Out))
  token1.tradeVolumeAVAX = token1.tradeVolumeAVAX.plus(trackedAmountAVAX)
  token1.tradeVolumeUSD = token1.tradeVolumeUSD.plus(trackedAmountUSD)
  token1.untrackedVolumeAVAX = token1.untrackedVolumeAVAX.plus(derivedAmountAVAX)
  token1.untrackedVolumeUSD = token1.untrackedVolumeUSD.plus(derivedAmountUSD)

  // update txn counts
  token0.txCount = token0.txCount.plus(ONE_BI)
  token1.txCount = token1.txCount.plus(ONE_BI)

  // update pair volume data, use tracked amount if we have it as its probably more accurate
  pair.volumeAVAX = pair.volumeAVAX.plus(trackedAmountAVAX)
  pair.volumeUSD = pair.volumeUSD.plus(trackedAmountUSD)
  pair.volumeToken0 = pair.volumeToken0.plus(amount0Total)
  pair.volumeToken1 = pair.volumeToken1.plus(amount1Total)
  pair.untrackedVolumeAVAX = pair.untrackedVolumeAVAX.plus(derivedAmountAVAX)
  pair.untrackedVolumeUSD = pair.untrackedVolumeUSD.plus(derivedAmountUSD)
  pair.txCount = pair.txCount.plus(ONE_BI)
  pair.save()

  // update global values, only used tracked amounts for volume
  let polarfox = PolarfoxFactory.load(FACTORY_ADDRESS)
  polarfox.totalVolumeUSD = polarfox.totalVolumeUSD.plus(trackedAmountUSD)
  polarfox.totalVolumeAVAX = polarfox.totalVolumeAVAX.plus(trackedAmountAVAX)
  polarfox.untrackedVolumeAVAX = polarfox.untrackedVolumeAVAX.plus(derivedAmountAVAX)
  polarfox.untrackedVolumeUSD = polarfox.untrackedVolumeUSD.plus(derivedAmountUSD)
  polarfox.txCount = polarfox.txCount.plus(ONE_BI)

  // save entities
  pair.save()
  token0.save()
  token1.save()
  polarfox.save()

  let transaction = Transaction.load(event.transaction.hash.toHexString())
  if (transaction === null) {
    transaction = new Transaction(event.transaction.hash.toHexString())
    transaction.blockNumber = event.block.number
    transaction.timestamp = event.block.timestamp
    transaction.mints = []
    transaction.swaps = []
    transaction.burns = []
  }
  let swaps = transaction.swaps
  let swap = new SwapEvent(
    event.transaction.hash
      .toHexString()
      .concat('-')
      .concat(BigInt.fromI32(swaps.length).toString())
  )

  // update swap event
  swap.transaction = transaction.id
  swap.pair = pair.id
  swap.timestamp = transaction.timestamp
  swap.transaction = transaction.id
  swap.sender = event.params.sender
  swap.amount0In = amount0In
  swap.amount1In = amount1In
  swap.amount0Out = amount0Out
  swap.amount1Out = amount1Out
  swap.to = dest
  swap.from = event.transaction.from
  swap.logIndex = event.logIndex
  // use the tracked amount if we have it
  swap.amountAVAX = trackedAmountAVAX === ZERO_BD ? derivedAmountAVAX : trackedAmountAVAX
  swap.amountUSD = trackedAmountUSD === ZERO_BD ? derivedAmountUSD : trackedAmountUSD
  swap.save()

  // update the transaction

  // TODO: Consider using .concat() for handling array updates to protect
  // against unintended side effects for other code paths.
  swaps.push(swap.id)
  transaction.swaps = swaps
  transaction.save()

  // update day entities
  let pairDayData = updatePairDayData(event)
  let pairHourData = updatePairHourData(event)
  let polarfoxDayData = updatePolarfoxDayData(event)
  let token0DayData = updateTokenDayData(token0 as Token, event)
  let token1DayData = updateTokenDayData(token1 as Token, event)

  // swap specific updating
  polarfoxDayData.dailyVolumeUSD = polarfoxDayData.dailyVolumeUSD.plus(trackedAmountUSD)
  polarfoxDayData.dailyVolumeAVAX = polarfoxDayData.dailyVolumeAVAX.plus(trackedAmountAVAX)
  polarfoxDayData.dailyVolumeUntracked = polarfoxDayData.dailyVolumeUntracked.plus(derivedAmountUSD)
  polarfoxDayData.save()

  // swap specific updating for pair
  pairDayData.dailyVolumeToken0 = pairDayData.dailyVolumeToken0.plus(amount0Total)
  pairDayData.dailyVolumeToken1 = pairDayData.dailyVolumeToken1.plus(amount1Total)
  pairDayData.dailyVolumeAVAX = pairDayData.dailyVolumeAVAX.plus(trackedAmountAVAX)
  pairDayData.dailyVolumeUSD = pairDayData.dailyVolumeUSD.plus(trackedAmountUSD)
  pairDayData.save()

  // update hourly pair data
  pairHourData.hourlyVolumeToken0 = pairHourData.hourlyVolumeToken0.plus(amount0Total)
  pairHourData.hourlyVolumeToken1 = pairHourData.hourlyVolumeToken1.plus(amount1Total)
  pairHourData.hourlyVolumeAVAX = pairHourData.hourlyVolumeAVAX.plus(trackedAmountAVAX)
  pairHourData.hourlyVolumeUSD = pairHourData.hourlyVolumeUSD.plus(trackedAmountUSD)
  pairHourData.save()

  // swap specific updating for token0
  token0DayData.dailyVolumeToken = token0DayData.dailyVolumeToken.plus(amount0Total)
  token0DayData.dailyVolumeAVAX = token0DayData.dailyVolumeAVAX.plus(amount0Total.times(token1.derivedAVAX as BigDecimal))
  token0DayData.dailyVolumeUSD = token0DayData.dailyVolumeUSD.plus(
    amount0Total.times(token0.derivedAVAX as BigDecimal).times(bundle.avaxPrice)
  )
  token0DayData.save()

  // swap specific updating
  token1DayData.dailyVolumeToken = token1DayData.dailyVolumeToken.plus(amount1Total)
  token1DayData.dailyVolumeAVAX = token1DayData.dailyVolumeAVAX.plus(amount1Total.times(token1.derivedAVAX as BigDecimal))
  token1DayData.dailyVolumeUSD = token1DayData.dailyVolumeUSD.plus(
    amount1Total.times(token1.derivedAVAX as BigDecimal).times(bundle.avaxPrice)
  )
  token1DayData.save()
}
