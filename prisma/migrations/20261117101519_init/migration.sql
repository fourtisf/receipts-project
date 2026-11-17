-- CreateEnum
CREATE TYPE "StrategyKind" AS ENUM ('HOUSE', 'TEMPLATE', 'AI');

-- CreateEnum
CREATE TYPE "StrategyCategory" AS ENUM ('CRYPTO', 'STOCK', 'MIXED');

-- CreateEnum
CREATE TYPE "CommitStatus" AS ENUM ('COMMITTED', 'REVEALED', 'MISSED');

-- CreateEnum
CREATE TYPE "MatchStatus" AS ENUM ('PENDING', 'MATCH', 'MISMATCH', 'NO_EXECUTION');

-- CreateEnum
CREATE TYPE "VaultEventType" AS ENUM ('CREATED', 'DEPOSITED', 'WITHDRAWN', 'FOLLOWED', 'UNFOLLOWED', 'ALLOCATION', 'LIMITS', 'PAUSED', 'OPERATOR', 'TOKEN', 'BREAKER', 'PEAK_RESET', 'MARKS_FROZEN', 'MARKS_RESET', 'FEES_SETTLED', 'FEE_DEFERRED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiweNonce" (
    "nonce" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "SiweNonce_pkey" PRIMARY KEY ("nonce")
);

-- CreateTable
CREATE TABLE "Strategy" (
    "id" INTEGER NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "kind" "StrategyKind" NOT NULL,
    "category" "StrategyCategory" NOT NULL,
    "template" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "assets" TEXT[],
    "creatorAddr" TEXT NOT NULL,
    "creatorUserId" TEXT,
    "signerAddr" TEXT NOT NULL,
    "modelId" TEXT,
    "modelHash" TEXT,
    "creatorShareBps" INTEGER NOT NULL,
    "revealWindowSec" INTEGER NOT NULL,
    "metadataURI" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "commitCount" INTEGER NOT NULL DEFAULT 0,
    "revealCount" INTEGER NOT NULL DEFAULT 0,
    "missedCount" INTEGER NOT NULL DEFAULT 0,
    "ret30d" DECIMAL(12,6),
    "hold30d" DECIMAL(12,6),
    "maxDrawdown30d" DECIMAL(12,6),
    "followers" INTEGER NOT NULL DEFAULT 0,
    "aumUsd" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "registeredTx" TEXT NOT NULL,
    "registeredAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Strategy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Commit" (
    "id" TEXT NOT NULL,
    "receiptNo" SERIAL NOT NULL,
    "strategyId" INTEGER NOT NULL,
    "nonce" INTEGER NOT NULL,
    "hash" TEXT NOT NULL,
    "status" "CommitStatus" NOT NULL,
    "committedAt" TIMESTAMP(3) NOT NULL,
    "committedL2Block" BIGINT NOT NULL,
    "commitTx" TEXT NOT NULL,
    "revealDeadline" TIMESTAMP(3) NOT NULL,
    "revealedAt" TIMESTAMP(3),
    "revealTx" TEXT,
    "missedTx" TEXT,
    "tokenIn" TEXT,
    "tokenOut" TEXT,
    "sizeBps" INTEGER,
    "promptHash" TEXT,
    "salt" TEXT,
    "priceInAtCommit" DECIMAL(38,18),
    "priceOutAtCommit" DECIMAL(38,18),
    "matchStatus" "MatchStatus" NOT NULL DEFAULT 'PENDING',
    "matchNote" TEXT,

    CONSTRAINT "Commit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiArtifact" (
    "id" TEXT NOT NULL,
    "commitId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "inputs" JSONB NOT NULL,
    "output" JSONB NOT NULL,
    "promptHash" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "AiArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecretSalt" (
    "id" TEXT NOT NULL,
    "strategyId" INTEGER NOT NULL,
    "nonce" INTEGER NOT NULL,
    "signalEnc" TEXT NOT NULL,
    "saltEnc" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revealedAt" TIMESTAMP(3),

    CONSTRAINT "SecretSalt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vault" (
    "address" TEXT NOT NULL,
    "ownerAddr" TEXT NOT NULL,
    "createdTx" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "followingId" INTEGER,
    "allocationUsd" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "maxSlippageBps" INTEGER NOT NULL,
    "dailyLimitUsd" DECIMAL(38,18) NOT NULL,
    "drawdownBps" INTEGER NOT NULL,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "operator" TEXT,
    "navUsd" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "peakNavUsd" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "hwmNavUsd" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "isHouse" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vault_pkey" PRIMARY KEY ("address")
);

-- CreateTable
CREATE TABLE "Execution" (
    "id" TEXT NOT NULL,
    "vaultAddr" TEXT NOT NULL,
    "commitId" TEXT NOT NULL,
    "strategyId" INTEGER NOT NULL,
    "nonce" INTEGER NOT NULL,
    "tokenIn" TEXT NOT NULL,
    "tokenOut" TEXT NOT NULL,
    "amountIn" DECIMAL(78,0) NOT NULL,
    "amountOut" DECIMAL(78,0) NOT NULL,
    "valueUsd" DECIMAL(38,18) NOT NULL,
    "minOut" DECIMAL(78,0) NOT NULL,
    "slippageVsOracleBps" INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "executedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Execution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VaultEvent" (
    "id" TEXT NOT NULL,
    "vaultAddr" TEXT NOT NULL,
    "type" "VaultEventType" NOT NULL,
    "data" JSONB NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VaultEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricePoint" (
    "id" BIGSERIAL NOT NULL,
    "token" TEXT NOT NULL,
    "feed" TEXT NOT NULL,
    "priceUsd" DECIMAL(38,18) NOT NULL,
    "roundId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PricePoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EquityPoint" (
    "id" BIGSERIAL NOT NULL,
    "strategyId" INTEGER NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "equity" DECIMAL(20,8) NOT NULL,
    "hold" DECIMAL(20,8) NOT NULL,

    CONSTRAINT "EquityPoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GlobalStat" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "receiptsPrinted" INTEGER NOT NULL DEFAULT 0,
    "strategiesLive" INTEGER NOT NULL DEFAULT 0,
    "missedReveals" INTEGER NOT NULL DEFAULT 0,
    "tvlUsd" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GlobalStat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IndexerCursor" (
    "id" TEXT NOT NULL,
    "lastBlock" BIGINT NOT NULL,
    "lastBlockHash" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IndexerCursor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertLog" (
    "id" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_address_key" ON "User"("address");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Strategy_slug_key" ON "Strategy"("slug");

-- CreateIndex
CREATE INDEX "Strategy_category_idx" ON "Strategy"("category");

-- CreateIndex
CREATE INDEX "Strategy_kind_idx" ON "Strategy"("kind");

-- CreateIndex
CREATE INDEX "Strategy_active_idx" ON "Strategy"("active");

-- CreateIndex
CREATE UNIQUE INDEX "Commit_receiptNo_key" ON "Commit"("receiptNo");

-- CreateIndex
CREATE UNIQUE INDEX "Commit_hash_key" ON "Commit"("hash");

-- CreateIndex
CREATE INDEX "Commit_status_idx" ON "Commit"("status");

-- CreateIndex
CREATE INDEX "Commit_committedAt_idx" ON "Commit"("committedAt");

-- CreateIndex
CREATE INDEX "Commit_strategyId_committedAt_idx" ON "Commit"("strategyId", "committedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Commit_strategyId_nonce_key" ON "Commit"("strategyId", "nonce");

-- CreateIndex
CREATE UNIQUE INDEX "AiArtifact_commitId_key" ON "AiArtifact"("commitId");

-- CreateIndex
CREATE UNIQUE INDEX "SecretSalt_strategyId_nonce_key" ON "SecretSalt"("strategyId", "nonce");

-- CreateIndex
CREATE UNIQUE INDEX "Vault_ownerAddr_key" ON "Vault"("ownerAddr");

-- CreateIndex
CREATE INDEX "Vault_followingId_idx" ON "Vault"("followingId");

-- CreateIndex
CREATE INDEX "Execution_commitId_idx" ON "Execution"("commitId");

-- CreateIndex
CREATE INDEX "Execution_vaultAddr_executedAt_idx" ON "Execution"("vaultAddr", "executedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Execution_txHash_logIndex_key" ON "Execution"("txHash", "logIndex");

-- CreateIndex
CREATE INDEX "VaultEvent_vaultAddr_at_idx" ON "VaultEvent"("vaultAddr", "at");

-- CreateIndex
CREATE UNIQUE INDEX "VaultEvent_txHash_logIndex_key" ON "VaultEvent"("txHash", "logIndex");

-- CreateIndex
CREATE INDEX "PricePoint_token_updatedAt_idx" ON "PricePoint"("token", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PricePoint_feed_roundId_key" ON "PricePoint"("feed", "roundId");

-- CreateIndex
CREATE UNIQUE INDEX "EquityPoint_strategyId_at_key" ON "EquityPoint"("strategyId", "at");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Strategy" ADD CONSTRAINT "Strategy_creatorUserId_fkey" FOREIGN KEY ("creatorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Commit" ADD CONSTRAINT "Commit_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiArtifact" ADD CONSTRAINT "AiArtifact_commitId_fkey" FOREIGN KEY ("commitId") REFERENCES "Commit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Execution" ADD CONSTRAINT "Execution_vaultAddr_fkey" FOREIGN KEY ("vaultAddr") REFERENCES "Vault"("address") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Execution" ADD CONSTRAINT "Execution_commitId_fkey" FOREIGN KEY ("commitId") REFERENCES "Commit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VaultEvent" ADD CONSTRAINT "VaultEvent_vaultAddr_fkey" FOREIGN KEY ("vaultAddr") REFERENCES "Vault"("address") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EquityPoint" ADD CONSTRAINT "EquityPoint_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
