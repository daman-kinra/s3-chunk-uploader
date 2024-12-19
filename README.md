# S3 Chunk Uploader

This library allows you to upload large media files to Amazon S3 in chunks. It supports parallel uploads and provides a simple interface for configuring and initiating the upload process.

## Installation

To install the library, use npm or yarn:

```bash
npm install s3-chunk-uploader
```

or

```bash
yarn add s3-chunk-uploader
```

## Usage

Here is an example of how to use the `ChunkUploader` class to upload a Media Blob in chunks:

```javascript
const uploader = new ChunkUploader({
  accessKeyId: "AccessKeyId",
  secretAccessKey: "SecretAccessKey",
  region: "Region",
});

const url = await uploader.uploadMediaInChunks({
  blob: Blob,
  key: "/path/to/media",
  bucket: "bucket-name",
  ACL: "public-read",
  strategy: "parallel",
  onProgress: (event) => {
    console.log(`Upload progress: ${event.progress}%`);
  },
});
```

### Parameters

- `accessKeyId`: Your AWS access key ID.
- `secretAccessKey`: Your AWS secret access key.
- `region`: The AWS region where your S3 bucket is located.
- `blob`: The media file blob to be uploaded.
- `key`: The destination key (path) in the S3 bucket.
- `bucket`: The name of the S3 bucket.
- `ACL`: The access control list for the uploaded file (e.g., `public-read`).
- `strategy`: The upload strategy (e.g., `parallel`).
- `onProgress`: A callback function to track the upload progress.

## License

This project is licensed under the MIT License.
