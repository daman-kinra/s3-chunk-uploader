import AWS from "aws-sdk";

type Part = { ETag: string | undefined; PartNumber: number };
type ProgressEvent = {
  progress: number;
};
type Strategy = "parallel" | "serial";

/**
 * Class to handle chunked uploads to S3.
 */
class ChunkUploader {
  private s3: AWS.S3;

  private MAX_RETRIES: number;

  private MIN_CHUNK_SIZE: number;

  private totalChunks: number = 0;

  private totalProgress: number = 0;

  private totalFileSize: number = 0;

  private parallelProgressTracker: { [key: number]: number } = {};

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

  /**
   * Delays execution for a specified time.
   * @param ms - Milliseconds to delay.
   * @returns Promise that resolves after the delay.
   */
  private static async delay(ms: number): Promise<boolean> {
    await new Promise((resolve) => {
      setTimeout(() => {
        resolve(true);
      }, ms);
    });
    return true;
  }

  /**
   * Uploads a chunk with retry logic.
   * @param partParams - Parameters for the chunk upload.
   * @param onProgress - Callback for progress updates.
   * @param attempt - Current attempt number.
   * @param strategy - Upload strategy (serial or parallel).
   * @param chunkId - ID of the chunk.
   * @returns Promise resolving to the uploaded part information.
   */
  private async uploadChunkWithRetry({
    partParams,
    onProgress,
    attempt = 1,
    strategy = "serial",
    chunkId,
  }: {
    partParams: AWS.S3.UploadPartRequest;
    onProgress?: (event: ProgressEvent) => void;
    attempt: number;
    strategy?: Strategy;
    chunkId: number;
  }): Promise<Part> {
    try {
      const handleParallelProgress = ({ loaded }: { loaded: number }) => {
        this.parallelProgressTracker[chunkId] = loaded;
        const totalChunksizeUploaded: number = Object.values(
          this.parallelProgressTracker
        ).reduce((acc: number, curr: number) => acc + curr, 0);
        const progress = Math.round(
          (totalChunksizeUploaded / this.totalFileSize) * 100
        );
        if (onProgress && typeof onProgress === "function") {
          let totalProgress = progress;
          if (totalProgress > 99) {
            totalProgress = 99;
          }
          onProgress({ progress: totalProgress });
        }
      };

      let localProgress = 0;
      const handleSerialProgress = ({
        loaded,
        total,
      }: {
        loaded: number;
        total: number;
      }) => {
        const progress = (loaded / total) * 100;
        const progressOutOfTotalChunks = Math.round(
          progress / this.totalChunks
        );
        localProgress = progressOutOfTotalChunks;
        if (onProgress && typeof onProgress === "function") {
          let totalProgress = this.totalProgress + progressOutOfTotalChunks;
          if (totalProgress > 99) {
            totalProgress = 99;
          }
          onProgress({ progress: totalProgress });
        }
      };

      const part = await this.s3
        .uploadPart(partParams)
        .on("httpUploadProgress", ({ loaded, total }) => {
          if (strategy === "serial") {
            handleSerialProgress({ loaded, total });
            return;
          }
          handleParallelProgress({ loaded });
        })
        .promise();

      this.totalProgress += localProgress;
      return { ETag: part.ETag, PartNumber: partParams.PartNumber };
    } catch (error) {
      if (attempt < this.MAX_RETRIES) {
        await ChunkUploader.delay(1000);
        return this.uploadChunkWithRetry({
          partParams,
          onProgress,
          attempt: attempt + 1,
          strategy,
          chunkId,
        });
      }
      throw error;
    }
  }

  /**
   * Uploads a media file to S3 in chunks.
   * @param blob - The media file to upload.
   * @param bucket - The S3 bucket to upload to.
   * @param key - The key for the uploaded file.
   * @param ACL - The ACL for the uploaded file.
   * @param strategy - The strategy to use for uploading chunks.
   * @param onProgress - Callback for progress updates.
   * @returns Promise resolving to the URL of the uploaded file.
   */
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
    strategy?: Strategy;
    onProgress?: (event: ProgressEvent) => void;
  }): Promise<string | undefined> {
    this.totalProgress = 0;
    this.totalFileSize = blob.size;
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
    this.totalChunks = chunks.length;
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
        // eslint-disable-next-line no-await-in-loop
        const part = await this.uploadChunkWithRetry({
          partParams,
          onProgress,
          strategy,
          chunkId: index,
          attempt: 1,
        });
        temp.push(part);
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
        return this.uploadChunkWithRetry({
          partParams,
          onProgress,
          strategy,
          chunkId: index,
          attempt: 1,
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
