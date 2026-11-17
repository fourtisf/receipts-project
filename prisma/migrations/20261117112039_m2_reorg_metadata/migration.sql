-- AlterTable
ALTER TABLE "Commit" ADD COLUMN     "missedBlock" BIGINT,
ADD COLUMN     "revealBlock" BIGINT;

-- AlterTable
ALTER TABLE "Strategy" ADD COLUMN     "registeredBlock" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Vault" ADD COLUMN     "createdBlock" BIGINT NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "MetadataDoc" (
    "hash" TEXT NOT NULL,
    "json" JSONB NOT NULL,
    "creatorAddr" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MetadataDoc_pkey" PRIMARY KEY ("hash")
);
