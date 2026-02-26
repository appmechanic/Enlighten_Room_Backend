import { S3Client } from '@aws-sdk/client-s3';
import 'dotenv/config';

export const s3 = new S3Client({
  region: process.env.DO_SPACE_REGION,
  endpoint: process.env.DO_SPACE_ENDPOINT,
  credentials: {
    accessKeyId: process.env.DO_SPACE_KEY,
    secretAccessKey: process.env.DO_SPACE_SECRET,
  },
});
