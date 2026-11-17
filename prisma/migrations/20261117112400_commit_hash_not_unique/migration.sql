-- DropIndex
DROP INDEX "Commit_hash_key";

-- CreateIndex
CREATE INDEX "Commit_hash_idx" ON "Commit"("hash");
