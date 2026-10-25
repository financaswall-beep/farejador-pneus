import { z } from 'zod';
export const catalogPhotoEnvShape={
 MATRIZ_CATALOG_PHOTOS_ENABLED:z.enum(['true','false']).default('false').transform(value=>value==='true'),
 MATRIZ_PHOTOS_DRIVE_SERVICE_ACCOUNT_JSON:z.preprocess(value=>value===''?undefined:value,z.string().max(65536).optional()),
};
