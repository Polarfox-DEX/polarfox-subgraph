/* eslint-disable prefer-const */
import { Pair, Token, Bundle } from '../types/schema'
import { BigDecimal, Address, BigInt } from '@graphprotocol/graph-ts/index'
import { ZERO_BD, factoryContract, ADDRESS_ZERO, ONE_BD } from './helpers'
import { log } from '@graphprotocol/graph-ts'

const WAVAX_ADDRESS = '0xd00ae08403B9bbb9124bB305C09058E32C39A48c'
// const DAI_WAVAX_PAIR = '' // created block xxx
// const USDC_WAVAX_PAIR = '' // created block xxx
const USDT_WAVAX_PAIR = '0x6fa3DF2D2C73E47010497FdcaE3ec2773A4f8dbB' // created block 362535

export function getAvaxPriceInUSD(): BigDecimal {
  // Fetch AVAX price for USDT
  let usdtPair = Pair.load(USDT_WAVAX_PAIR) // USDT is token0
  // TODO: Double-check the above is true when creating this on the mainnet

  // If the USDT pair has been created
  if (usdtPair !== null) {
    return usdtPair.token0Price
  } else {
    let ret = ONE_BD.times(BigDecimal.fromString('2')).div(BigDecimal.fromString('2'))
    return ret // hack, REMOVE!
  }
}

// TODO: Add other stablecoins as time goes, then uncomment this
// export function getAvaxPriceInUSD(): BigDecimal {
//   // fetch avax prices for each stablecoin
//   let daiPair = Pair.load(DAI_WAVAX_PAIR) // dai is token0
//   let usdcPair = Pair.load(USDC_WAVAX_PAIR) // usdc is token0
//   let usdtPair = Pair.load(USDT_WAVAX_PAIR) // usdt is token1

//   // all 3 have been created
//   if (daiPair !== null && usdcPair !== null && usdtPair !== null) {
//     let totalLiquidityAVAX = daiPair.reserve1.plus(usdcPair.reserve1).plus(usdtPair.reserve0)
//     let daiWeight = daiPair.reserve1.div(totalLiquidityAVAX)
//     let usdcWeight = usdcPair.reserve1.div(totalLiquidityAVAX)
//     let usdtWeight = usdtPair.reserve0.div(totalLiquidityAVAX)
//     return daiPair.token0Price
//       .times(daiWeight)
//       .plus(usdcPair.token0Price.times(usdcWeight))
//       .plus(usdtPair.token1Price.times(usdtWeight))
//     // dai and USDC have been created
//   } else if (daiPair !== null && usdcPair !== null) {
//     let totalLiquidityAVAX = daiPair.reserve1.plus(usdcPair.reserve1)
//     let daiWeight = daiPair.reserve1.div(totalLiquidityAVAX)
//     let usdcWeight = usdcPair.reserve1.div(totalLiquidityAVAX)
//     return daiPair.token0Price.times(daiWeight).plus(usdcPair.token0Price.times(usdcWeight))
//     // USDC is the only pair so far
//   } else if (usdcPair !== null) {
//     return usdcPair.token0Price
//   } else {
//     //return ONE_BD.times(BigDecimal.fromString("4")) // hack, REMOVE!
//     let ret = ONE_BD.times(BigDecimal.fromString('2')).div(BigDecimal.fromString('2'))
//     return ret // hack, REMOVE!
//   }
// }

// Token where amounts should contribute to tracked volume and liquidity
let WHITELIST: string[] = [
  WAVAX_ADDRESS, // WAVAX
  '0xAA9344D903ef9034612e8221C0e0eF3B744A42BF', // PFX
  '0x598d84C62B6a9Af2FcF6DA1D9Bff52f9dd7D8226', // WETH
  '0x8E18dEF819C5C50937e883dD9ecc5B6783224aC7', // USDT
  '0xFf2Ebd79c0948C8fE69b96434915ABC03Ebb5c37', // AKITA
  '0x8BAb1Be3571a54e8dB6b975eb39ceDE251A1C6dF' // gAKITA
]

// minimum liquidity required to count towards tracked volume for pairs with small # of Lps
let MINIMUM_USD_THRESHOLD_NEW_PAIRS = BigDecimal.fromString('10')

// minimum liquidity for price to get tracked
let MINIMUM_LIQUIDITY_THRESHOLD_AVAX = BigDecimal.fromString('1')

/**
 * Search through graph to find derived AVAX per token.
 * @todo update to be derived AVAX (add stablecoin estimates)
 **/
export function findAvaxPerToken(token: Token): BigDecimal {
  if (token.id == WAVAX_ADDRESS) {
    return ONE_BD
  }
  // loop through whitelist and check if paired with any
  for (let i = 0; i < WHITELIST.length; ++i) {
    let pairAddress = factoryContract.getPair(Address.fromString(token.id), Address.fromString(WHITELIST[i]))
    if (pairAddress.toHexString() != ADDRESS_ZERO) {
      let pair = Pair.load(pairAddress.toHexString())
      if (pair.token0 == token.id && pair.reserveAVAX.gt(MINIMUM_LIQUIDITY_THRESHOLD_AVAX)) {
        let token1 = Token.load(pair.token1)
        return pair.token1Price.times(token1.derivedAVAX as BigDecimal) // return token1 per our token * Avax per token 1
      }
      if (pair.token1 == token.id && pair.reserveAVAX.gt(MINIMUM_LIQUIDITY_THRESHOLD_AVAX)) {
        let token0 = Token.load(pair.token0)
        return pair.token0Price.times(token0.derivedAVAX as BigDecimal) // return token0 per our token * AVAX per token 0
      }
    }
  }
  return ZERO_BD // nothing was found return 0
}

/**
 * Accepts tokens and amounts, return tracked amount based on token whitelist
 * If one token on whitelist, return amount in that token converted to USD.
 * If both are, return average of two amounts
 * If neither is, return 0
 */
export function getTrackedVolumeUSD(
  tokenAmount0: BigDecimal,
  token0: Token,
  tokenAmount1: BigDecimal,
  token1: Token,
  pair: Pair
): BigDecimal {
  let bundle = Bundle.load('1')
  let price0 = token0.derivedAVAX.times(bundle.avaxPrice)
  let price1 = token1.derivedAVAX.times(bundle.avaxPrice)

  // if less than 5 LPs, require high minimum reserve amount amount or return 0
  if (pair.liquidityProviderCount.lt(BigInt.fromI32(5))) {
    let reserve0USD = pair.reserve0.times(price0)
    let reserve1USD = pair.reserve1.times(price1)
    if (WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
      if (reserve0USD.plus(reserve1USD).lt(MINIMUM_USD_THRESHOLD_NEW_PAIRS)) {
        return ZERO_BD
      }
    }
    if (WHITELIST.includes(token0.id) && !WHITELIST.includes(token1.id)) {
      if (reserve0USD.times(BigDecimal.fromString('2')).lt(MINIMUM_USD_THRESHOLD_NEW_PAIRS)) {
        return ZERO_BD
      }
    }
    if (!WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
      if (reserve1USD.times(BigDecimal.fromString('2')).lt(MINIMUM_USD_THRESHOLD_NEW_PAIRS)) {
        return ZERO_BD
      }
    }
  }

  // both are whitelist tokens, take average of both amounts
  if (WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
    return tokenAmount0
      .times(price0)
      .plus(tokenAmount1.times(price1))
      .div(BigDecimal.fromString('2'))
  }

  // take full value of the whitelisted token amount
  if (WHITELIST.includes(token0.id) && !WHITELIST.includes(token1.id)) {
    return tokenAmount0.times(price0)
  }

  // take full value of the whitelisted token amount
  if (!WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
    return tokenAmount1.times(price1)
  }

  // neither token is on white list, tracked volume is 0
  return ZERO_BD
}

/**
 * Accepts tokens and amounts, return tracked amount based on token whitelist
 * If one token on whitelist, return amount in that token converted to USD * 2.
 * If both are, return sum of two amounts
 * If neither is, return 0
 */
export function getTrackedLiquidityUSD(tokenAmount0: BigDecimal, token0: Token, tokenAmount1: BigDecimal, token1: Token): BigDecimal {
  let bundle = Bundle.load('1')
  let price0 = token0.derivedAVAX.times(bundle.avaxPrice)
  let price1 = token1.derivedAVAX.times(bundle.avaxPrice)

  // both are whitelist tokens, take average of both amounts
  if (WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
    return tokenAmount0.times(price0).plus(tokenAmount1.times(price1))
  }

  // take double value of the whitelisted token amount
  if (WHITELIST.includes(token0.id) && !WHITELIST.includes(token1.id)) {
    return tokenAmount0.times(price0).times(BigDecimal.fromString('2'))
  }

  // take double value of the whitelisted token amount
  if (!WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
    return tokenAmount1.times(price1).times(BigDecimal.fromString('2'))
  }

  // neither token is on white list, tracked volume is 0
  return ZERO_BD
}
