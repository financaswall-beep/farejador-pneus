import './inventory-stock-tools.js';
import './inventory-catalog-tools.js';
import './inventory-media-tools.js';
import {inventoryRegistry} from './inventory-registry.js';
export {invokeInventoryTool} from './inventory-registry.js';
export const inventoryTools=[...inventoryRegistry.values()].map(tool=>tool.descriptor);
export const hasInventoryTool=(name:string)=>inventoryRegistry.has(name);
