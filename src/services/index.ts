import AWS from "aws-sdk";

type Part = { ETag: string | undefined; PartNumber: number };

/**
 * Uploads a media file to S3 in chunks.
 *
 * @param {Object} params - The parameters for the upload.
 * @param {Blob} params.blob - The media file to upload.
 * @param {string} params.bucket - The S3 bucket to upload to.
 * @param {string} params.key - The key for the uploaded file.
 * @param {AWS.S3.BucketCannedACL} params.ACL - The ACL for the uploaded file.
 * @param {"parallel" | "serial"} [params.strategy="serial"] - The strategy to use for uploading chunks.
 *        "serial" uploads chunks one after another, while "parallel" uploads chunks concurrently.
 *
 * @returns {Promise<string | undefined>} - The URL of the uploaded file, or undefined if the upload fails.
 *
 * @throws {Error} - Throws an error if the upload fails after the maximum number of retries.
 */
class ChunkUploader {
  private s3: AWS.S3;
  private MAX_RETRIES: number;
  private MIN_CHUNK_SIZE: number;
  constructor({
    accessKeyId,
    secretAccessKey,
    region,
    MAX_RETRIES = 3,
    MIN_CHUNK_SIZE = 5 * 1024 * 1024,
  }: {
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
    MAX_RETRIES?: number;
    MIN_CHUNK_SIZE?: number;
  }) {
    AWS.config.update({
      accessKeyId,
      secretAccessKey,
      region,
    });
    this.s3 = new AWS.S3();
    this.MAX_RETRIES = MAX_RETRIES;
    this.MIN_CHUNK_SIZE = MIN_CHUNK_SIZE;
  }
  private async delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  private async uploadChunkWithRetry(
    partParams: AWS.S3.UploadPartRequest,
    attempt: number = 1
  ): Promise<Part> {
    try {
      const part = await this.s3.uploadPart(partParams).promise();
      return { ETag: part.ETag, PartNumber: partParams.PartNumber };
    } catch (error) {
      if (attempt < this.MAX_RETRIES) {
        await this.delay(1000);
        return this.uploadChunkWithRetry(partParams, attempt + 1);
      }
      throw error;
    }
  }

  async uploadMediaInChunks({
    blob,
    bucket,
    key,
    ACL,
    strategy = "serial",
    onProgress,
  }: {
    blob: Blob;
    bucket: string;
    key: string;
    ACL: AWS.S3.BucketCannedACL;
    strategy: "parallel" | "serial";
    onProgress?: (progress: number) => void;
  }): Promise<string | undefined> {
    const chunks = [];
    let offset = 0;

    while (offset < blob.size) {
      let end = offset + this.MIN_CHUNK_SIZE;
      if (end > blob.size) {
        end = blob.size;
      }
      const chunk = blob.slice(offset, end);
      chunks.push(chunk);
      offset += this.MIN_CHUNK_SIZE;
    }
    const multipartParams: AWS.S3.CreateMultipartUploadRequest = {
      Bucket: bucket,
      Key: key,
      ACL,
    };

    const multipart: AWS.S3.CreateMultipartUploadOutput = await this.s3
      .createMultipartUpload(multipartParams)
      .promise();
    const uploadId = multipart.UploadId as string;

    let parts: Part[] = [];
    let temp: Part[] = [];
    let uploadedBytes = 0;
    if (strategy === "serial") {
      for (let index = 0; index < chunks.length; index++) {
        const chunk = chunks[index];
        const partParams: AWS.S3.UploadPartRequest = {
          Bucket: bucket,
          Key: key,
          PartNumber: index + 1,
          UploadId: uploadId,
          Body: chunk,
        };
        const part = await this.uploadChunkWithRetry(partParams);
        temp.push(part);
        uploadedBytes += chunk.size;
        if (onProgress) {
          const progress = (uploadedBytes / blob.size) * 100;
          onProgress(progress);
        }
      }
    } else if (strategy === "parallel") {
      const partsPromises = chunks.map((chunk, index) => {
        const partParams: AWS.S3.UploadPartRequest = {
          Bucket: bucket,
          Key: key,
          PartNumber: index + 1,
          UploadId: uploadId,
          Body: chunk,
        };
        return this.uploadChunkWithRetry(partParams).then((part) => {
          uploadedBytes += chunk.size;
          if (onProgress) {
            const progress = (uploadedBytes / blob.size) * 100;
            onProgress(progress);
          }
          return part;
        });
      });
      temp = await Promise.all(partsPromises);
    }
    parts = temp;
    const completeParams: AWS.S3.CompleteMultipartUploadRequest = {
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: parts,
      },
    };

    const complete = await this.s3
      .completeMultipartUpload(completeParams)
      .promise();
    return complete.Location;
  }
}

export { ChunkUploader };
