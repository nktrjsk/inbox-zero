-- CreateEnum
CREATE TYPE "BulkProcessJobStatus" AS ENUM ('RUNNING', 'STOPPED', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "BulkProcessJob" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "status" "BulkProcessJobStatus" NOT NULL DEFAULT 'RUNNING',
    "after" TIMESTAMP(3) NOT NULL,
    "before" TIMESTAMP(3),
    "includeRead" BOOLEAN NOT NULL DEFAULT false,
    "maxEmails" INTEGER,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "ruleRuns" INTEGER NOT NULL DEFAULT 0,
    "pageToken" TEXT,
    "error" TEXT,
    "emailAccountId" TEXT NOT NULL,

    CONSTRAINT "BulkProcessJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BulkProcessJob_emailAccountId_status_idx" ON "BulkProcessJob"("emailAccountId", "status");

-- CreateIndex
CREATE INDEX "BulkProcessJob_status_updatedAt_idx" ON "BulkProcessJob"("status", "updatedAt");

-- AddForeignKey
ALTER TABLE "BulkProcessJob" ADD CONSTRAINT "BulkProcessJob_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
