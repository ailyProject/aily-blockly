// --- Interfaces for Type Safety ---

export interface BlocklyField {
    [key: string]: string | number | boolean;
}

export interface BlocklyBlock {
    type: string;
    id: string;
    fields?: BlocklyField;
    inputs?: { [key: string]: { block?: BlocklyBlock } };
    next?: { block?: BlocklyBlock };
    // Allow for other properties we might not strictly need to type
    [key: string]: any;
}

export interface ProjectAbi {
    blocks: {
        languageVersion: number;
        blocks: BlocklyBlock[];
    };
}

/**
 * Core Logic: Updates a field value of a specific block in the Blockly project data structure.
 * This function is pure logic and can be used in both Node.js and Browser environments.
 * 
 * @param projectData The parsed JSON object of the project.abi file.
 * @param blockId The ID of the block to update.
 * @param newValue The new value to set.
 * @param fieldName The field name to update (default: "TEXT").
 * @returns True if the block was found and updated, false otherwise.
 */
export function updateBlockInObject(
    projectData: ProjectAbi, 
    blockId: string, 
    newValue: string | number | boolean, 
    fieldName: string = "TEXT"
): boolean {
    if (!projectData || !projectData.blocks || !projectData.blocks.blocks) {
        console.error("Invalid project data structure");
        return false;
    }

    // Helper function for recursive traversal
    const traverse = (blocks: BlocklyBlock[]): boolean => {
        for (const block of blocks) {
            // 1. Check current block
            if (block.id === blockId) {
                if (!block.fields) {
                    block.fields = {};
                }
                // Update the field
                block.fields[fieldName] = newValue;
                return true; // Found and updated
            }

            // 2. Recursively check inputs (nested blocks)
            if (block.inputs) {
                for (const key in block.inputs) {
                    const input = block.inputs[key];
                    if (input.block) {
                        if (traverse([input.block])) return true;
                    }
                }
            }

            // 3. Recursively check next (connected blocks)
            if (block.next && block.next.block) {
                if (traverse([block.next.block])) return true;
            }
        }
        return false;
    };

    return traverse(projectData.blocks.blocks);
}

/**
 * Node.js Helper: Reads a project file, updates a block, and writes it back.
 * Use this if you are running in a Node.js environment (e.g., Electron, Backend).
 * 
 * @param filePath The absolute path to the project.abi file.
 * @param blockId The ID of the block to update.
 * @param newValue The new value to set.
 * @param fieldName The field name to update (default: "TEXT").
 */
export function updateBlockInFile(
    filePath: string, 
    blockId: string, 
    newValue: string | number | boolean, 
    fieldName: string = "TEXT"
): void {
    try {
        // 1. Read File
        const fileContent = window['fs'].readFileSync(filePath, 'utf8');
        const projectData: ProjectAbi = JSON.parse(fileContent);

        // 2. Update Object
        const updated = updateBlockInObject(projectData, blockId, newValue, fieldName);

        // 3. Write File (only if updated)
        if (updated) {
            window['fs'].writeFileSync(filePath, JSON.stringify(projectData, null, 2), 'utf8');
            console.log(`Successfully updated block ${blockId} in ${filePath}`);
        } else {
            console.warn(`Block ${blockId} not found in ${filePath}`);
        }
    } catch (error) {
        console.error(`Failed to update file ${filePath}:`, error);
        throw error;
    }
}

/**
 * Node.js Helper: Reads a project file, updates multiple blocks using a JSON object, and writes it back.
 * This avoids opening and closing the file multiple times.
 * 
 * @param filePath The absolute path to the project.abi file.
 * @param updates A JSON object where keys are block IDs and values are the new values.
 *                Example: { "block_id_1": "value1", "block_id_2": 123 }
 *                To specify a field name, use an object: { "block_id_3": { value: "val", field: "FIELD_NAME" } }
 */
export function updateBlocksInFile(
    filePath: string, 
    updates: { [blockId: string]: string | number | boolean | { value: string | number | boolean, field?: string } }
): void {
    try {
        // 1. Read File
        const fileContent = window['fs'].readFileSync(filePath, 'utf8');
        const projectData: ProjectAbi = JSON.parse(fileContent);
        let hasChanges = false;

        // 2. Update Object
        for (const blockId in updates) {
            if (Object.prototype.hasOwnProperty.call(updates, blockId)) {
                const updateData = updates[blockId];
                let newValue: string | number | boolean;
                let fieldName = "TEXT";

                if (typeof updateData === 'object' && updateData !== null && 'value' in updateData) {
                    // Handle complex object { value: ..., field: ... }
                    const complexUpdate = updateData as { value: string | number | boolean, field?: string };
                    newValue = complexUpdate.value;
                    if (complexUpdate.field) {
                        fieldName = complexUpdate.field;
                    }
                } else {
                    // Handle simple value
                    newValue = updateData as string | number | boolean;
                }

                const updated = updateBlockInObject(projectData, blockId, newValue, fieldName);
                if (updated) {
                    hasChanges = true;
                    // console.log(`Successfully updated block ${blockId}`);
                } else {
                    console.warn(`Block ${blockId} not found in ${filePath}`);
                }
            }
        }

        // 3. Write File (only if updated)
        if (hasChanges) {
            window['fs'].writeFileSync(filePath, JSON.stringify(projectData, null, 2), 'utf8');
            // console.log(`Successfully updated blocks in ${filePath}`);
        }
    } catch (error) {
        console.error(`Failed to update file ${filePath}:`, error);
        throw error;
    }
}

// --- Example Usage (Uncomment to test) ---
/*
const samplePath = path.join(__dirname, 'project.abi');
// Update AUTH (TEXT field)
updateBlockInFile(samplePath, "2MZ{P}onF2k6FNqNS6s}", "NEW_KEY_FROM_TS");
// Update a Number field (example)
// updateBlockInFile(samplePath, "some_number_block_id", 123, "NUM");
*/
