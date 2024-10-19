import type {
  MarketWrapper,
  ParclV3Sdk,
  PositionWrapper,
} from "../../v3-sdk-ts/src";
import {
  Keypair,
  PublicKey,
  Connection,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { calculateAcceptablePrice } from "./transaction";
import { type PriceData } from "@pythnetwork/client";

import { getMarketPda, parsePrice, parseSize } from "../../v3-sdk-ts/src";
import { TransactionManager } from "./blockhash";

export async function handleOpenPositions(
  prclSDK: ParclV3Sdk,
  exchangeAddress: PublicKey,
  marginAccountAddress: PublicKey,
  signer: Keypair,
  openPositions: PositionWrapper[],
  marketWrappers: MarketWrapper[],
  connection: Connection,
  closeAtIndex?: boolean
) {
  let transaction = prclSDK.transactionBuilder();
  let currentBatchCount = 0;

  const tm = new TransactionManager(connection);
  const blockhash = await tm.getLatestBlockhash();

  const marketMap = new Map(
    marketWrappers.map((market) => [market.market.id, market])
  );

  const openPositionMarkets: MarketWrapper[] = [];

  for (const position of openPositions) {
    const market = marketMap.get(position.marketId());
    if (market) {
      openPositionMarkets.push(market);
    }
  }

  for (const position of openPositions) {
    const marketToTrade = marketMap.get(position.marketId());
    if (!marketToTrade) continue;

    const marketSkew = Number(marketToTrade.market.accounting.skew);
    const marketSize = position.size().val.dividedBy(1e9);

    const oppositeSkewShort = marketSize.greaterThan(0) && marketSkew > 0;
    const oppositeSkewLong = marketSize.lessThan(0) && marketSkew < 0;

    if (oppositeSkewShort || oppositeSkewLong || closeAtIndex) {
      let closingSize;
      if (closeAtIndex) {
        closingSize = -Number(marketSize);
      } else {
        if (!oppositeSkewShort) {
          closingSize =
            Number(
              marketSize.greaterThan(marketSkew) ? marketSize : marketSkew
            ) * -1;
        } else {
          closingSize =
            Number(marketSize.lessThan(marketSkew) ? marketSize : marketSkew) *
            -1;
        }
      }

      const pythPriceFeed = (await prclSDK.accountFetcher.getPythPriceFeed(
        marketToTrade.priceFeed()
      )) as PriceData;

      if (!pythPriceFeed?.price) continue;

      const acceptablePrice = closeAtIndex
        ? parsePrice((closingSize > 0 ? 1.1 : 0.9) * pythPriceFeed.price)
        : calculateAcceptablePrice(oppositeSkewLong, pythPriceFeed.price);

      transaction = transaction.modifyPosition(
        {
          exchange: exchangeAddress,
          marginAccount: marginAccountAddress,
          signer: signer.publicKey,
        },
        {
          sizeDelta: closingSize,
          marketId: position.marketId(),
          acceptablePrice: acceptablePrice,
        },
        openPositionMarkets.map((marketWrapper) => {
          const [marketAddress] = getMarketPda(
            exchangeAddress,
            marketWrapper.market.id
          );

          return marketAddress;
        }),
        openPositionMarkets.map((marketWrapper) => {
          return marketWrapper.priceFeed();
        })
      );

      currentBatchCount++;

      if (currentBatchCount === 3) {
        const tx = transaction
          .feePayer(signer.publicKey)
          .buildSigned([signer], blockhash);

        try {
          const result = await sendAndConfirmTransaction(connection, tx, [
            signer,
          ]);
        } catch (e) {
          console.error(e);
        } //might cause error 6000 that is integer overflow and is completly random. need to be fixed by prcl!!!!!!

        transaction = prclSDK.transactionBuilder();
        currentBatchCount = 0;
      }
    }
  }

  if (currentBatchCount > 0) {
    const tx = transaction
      .feePayer(signer.publicKey)
      .buildSigned([signer], blockhash);

    try {
      const result = await sendAndConfirmTransaction(connection, tx, [signer]);
    } catch (e) {
      console.error(e);
    } //might cause error 6000 that is integer overflow and is completly random. need to be fixed by prcl!!!!!!
  }
}
