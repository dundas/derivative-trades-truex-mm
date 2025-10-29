/**
 * D1 Client Utility
 * 
 * This module provides a consistent interface for D1 database operations
 * using Wrangler CLI for remote D1 access or direct D1 access for local development.
 */

import { execSync } from 'child_process';

/**
 * D1 Client class
 */
class D1Client {
  /**
   * Create a new D1 client
   * @param {Object} options - D1 client options
   * @param {boolean} [options.useRemote=true] - Use remote D1 database
   * @param {string} [options.dbPath] - Path to local D1 database file
   * @param {string} [options.databaseName='decisive_trades'] - D1 database name
   */
  constructor(options = {}) {
    this.useRemote = options.useRemote !== false; // Default to remote
    this.dbPath = options.dbPath;
    this.databaseName = options.databaseName || 'decisive_trades';
    
    console.log(`D1Client initialized: ${this.useRemote ? 'Remote' : 'Local'} mode`);
    if (this.dbPath) {
      console.log(`Using local database at: ${this.dbPath}`);
    }
  }

  /**
   * Test the D1 connection
   * @returns {Promise<boolean>} True if connection is successful
   */
  async testConnection() {
    try {
      // Simple query to test connection
      const result = await this.prepare('SELECT 1 as test').bind().all();
      return result.success;
    } catch (error) {
      console.error('D1 connection test failed:', error.message);
      throw error;
    }
  }

  /**
   * Execute a SQL statement directly
   * @param {string} sql - SQL statement to execute
   * @returns {Promise<Object>} Result object
   */
  async exec(sql) {
    console.log(`D1 EXEC: ${sql}`);
    try {
      const command = `npx wrangler d1 execute ${this.databaseName} --remote --command="${sql.replace(/"/g, '\"')}"${this.dbPath ? ` --local --database-file=${this.dbPath}` : ''}`;
      const result = execSync(command, { encoding: 'utf8' });
      console.log(`D1 EXEC Result: ${result.substring(0, 200)}...`);
      return { success: true };
    } catch (error) {
      console.error(`D1 EXEC Error: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Prepare a SQL statement
   * @param {string} sql - SQL statement to prepare
   * @returns {Object} Prepared statement object
   */
  prepare(sql) {
    console.log(`D1 PREPARE: ${sql}`);
    
    return {
      bind: (...params) => {
        console.log(`D1 BIND: ${JSON.stringify(params).substring(0, 100)}...`);
        
        // For SELECTs, execute directly
        if (sql.toLowerCase().startsWith('select')) {
          return {
            all: async () => {
              try {
                const paramSql = this.replacePlaceholders(sql, params);
                const command = `npx wrangler d1 execute ${this.databaseName} --remote --command="${paramSql.replace(/"/g, '\"')}" --json${this.dbPath ? ` --local --database-file=${this.dbPath}` : ''}`;
                const result = execSync(command, { encoding: 'utf8' });
                const json = JSON.parse(result);
                return { results: json, success: true };
              } catch (error) {
                console.error(`D1 ALL Error: ${error.message}`);
                return { results: [], success: false, error: error.message };
              }
            },
            first: async () => {
              try {
                const paramSql = this.replacePlaceholders(sql, params);
                const command = `npx wrangler d1 execute ${this.databaseName} --remote --command="${paramSql.replace(/"/g, '\"')}" --json${this.dbPath ? ` --local --database-file=${this.dbPath}` : ''}`;
                const result = execSync(command, { encoding: 'utf8' });
                const json = JSON.parse(result);
                return { results: json[0] || null, success: true };
              } catch (error) {
                console.error(`D1 FIRST Error: ${error.message}`);
                return { results: null, success: false, error: error.message };
              }
            }
          };
        }
        
        // For INSERT/UPDATE/DELETE, execute and return metadata
        return {
          run: async () => {
            try {
              const paramSql = this.replacePlaceholders(sql, params);
              const command = `npx wrangler d1 execute ${this.databaseName} --remote --command="${paramSql.replace(/"/g, '\"')}"${this.dbPath ? ` --local --database-file=${this.dbPath}` : ''}`;
              const result = execSync(command, { encoding: 'utf8' });
              console.log(`D1 RUN Result: ${result.substring(0, 200)}...`);
              return { 
                success: true, 
                meta: { changes: 1 } 
              };
            } catch (error) {
              console.error(`D1 RUN Error: ${error.message}`);
              return { 
                success: false, 
                meta: { changes: 0 }, 
                error: error.message 
              };
            }
          }
        };
      }
    };
  }

  /**
   * Replace placeholders in SQL with parameter values
   * @param {string} sql - SQL statement with placeholders
   * @param {Array} params - Parameter values
   * @returns {string} SQL statement with parameters
   * @private
   */
  replacePlaceholders(sql, params) {
    let result = sql;
    params.forEach((param, index) => {
      // Format the parameter based on its type
      let formattedParam;
      if (param === null) {
        formattedParam = 'NULL';
      } else if (typeof param === 'string') {
        // Escape single quotes for SQL
        formattedParam = `'${param.replace(/'/g, "''")}'`;
      } else if (typeof param === 'number') {
        formattedParam = param.toString();
      } else if (typeof param === 'boolean') {
        formattedParam = param ? '1' : '0';
      } else {
        // For objects, arrays, etc. - stringify and wrap in quotes
        formattedParam = `'${JSON.stringify(param).replace(/'/g, "''")}'`;
      }
      
      // Replace the first occurrence of ?
      result = result.replace('?', formattedParam);
    });
    return result;
  }

  /**
   * Execute a batch of SQL statements
   * @param {Array} statements - Array of statement objects with sql and params
   * @returns {Promise<Object>} Result object
   */
  async batch(statements) {
    console.log(`D1 batch: Processing ${statements.length} statements`);
    
    // Group statements by table and operation type for bulk processing
    const insertGroups = new Map();
    
    // First, group statements by table and operation
    for (const statement of statements) {
      const { sql, params } = statement;
      
      // Check if this is an INSERT statement
      if (sql.toLowerCase().trim().startsWith('insert into')) {
        // Extract table name and columns from SQL
        // Example: INSERT INTO tablename (col1, col2) VALUES (?, ?)
        const tableMatch = sql.match(/insert\s+into\s+(\w+)\s*\(([^)]+)\)/i);
        
        if (tableMatch && tableMatch.length >= 3) {
          const tableName = tableMatch[1];
          const columns = tableMatch[2].split(',').map(col => col.trim());
          
          // Create a key for this table+columns combination
          const key = `${tableName}:${columns.join(',')}`;
          
          // Add to the group
          if (!insertGroups.has(key)) {
            insertGroups.set(key, {
              tableName,
              columns,
              rows: []
            });
          }
          
          // Add the row data
          insertGroups.get(key).rows.push(params);
          continue;
        }
      }
      
      // If we couldn't group this statement, process it individually
      try {
        const paramSql = this.replacePlaceholders(sql, params);
        const command = `npx wrangler d1 execute ${this.databaseName} --remote --command="${paramSql.replace(/"/g, '\"')}"${this.dbPath ? ` --local --database-file=${this.dbPath}` : ''}`;
        execSync(command, { encoding: 'utf8' });
        console.log(`D1 individual statement executed successfully`);
      } catch (error) {
        console.error(`D1 individual statement failed: ${error.message.substring(0, 200)}...`);
      }
    }
    
    // Process each group using bulk insert
    let totalSuccess = 0;
    
    for (const [key, group] of insertGroups) {
      const { tableName, columns, rows } = group;
      console.log(`Processing bulk insert for ${tableName} with ${rows.length} rows`);
      
      const result = await this.batchInsert(tableName, columns, rows);
      totalSuccess += result.successCount;
    }
    
    console.log(`D1 batch completed: ${totalSuccess}/${statements.length} operations successful`);
    
    return {
      success: totalSuccess > 0,
      meta: { changes: totalSuccess }
    };
  }
  
  /**
   * Helper function for batch inserts that respects D1's 100 parameter limit
   * Inspired by the implementation in orderbook-archiver-worker.js
   * @param {string} tableName - Table name
   * @param {Array<string>} columns - Column names
   * @param {Array<Array>} rows - Array of row data arrays
   * @returns {Promise<Object>} Result object
   */
  async batchInsert(tableName, columns, rows) {
    // INSERT INTO table (col1, col2) VALUES
    const queryPrefix = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES `;
    
    // Prepare batches of queries and parameters
    const batches = [];
    
    // Current batch values and parameters
    let values = [];
    let params = [];
    
    // Process each row
    for (const row of rows) {
      // Check if adding this row would exceed the 100 parameter limit
      if (params.length + row.length > 100) {
        // Store current batch and start a new one
        if (values.length > 0) {
          const query = queryPrefix + values.join(', ') + ';';
          batches.push({ query, params });
          
          // Reset for new batch
          values = [];
          params = [];
        }
      }
      
      // Add row to current batch
      const placeholders = Array(row.length).fill('?').join(', ');
      values.push(`(${placeholders})`);
      params.push(...row);
    }
    
    // Add any remaining rows as the final batch
    if (values.length > 0) {
      const query = queryPrefix + values.join(', ') + ';';
      batches.push({ query, params });
    }
    
    console.log(`Created ${batches.length} batches for ${rows.length} rows`);
    
    // Execute all batches
    let successCount = 0;
    
    for (let i = 0; i < batches.length; i++) {
      const { query, params } = batches[i];
      try {
        console.log(`Executing batch ${i+1}/${batches.length} with ${params.length} parameters`);
        
        // For very large batches, try splitting them further if they fail
        try {
          const paramSql = this.replacePlaceholders(query, params);
          const command = `npx wrangler d1 execute ${this.databaseName} --remote --command="${paramSql.replace(/"/g, '\"')}"${this.dbPath ? ` --local --database-file=${this.dbPath}` : ''}`;
          
          // Log the first 200 characters of the command for debugging
          console.log(`Command preview (first 200 chars): ${command.substring(0, 200)}...`);
          
          try {
            const output = execSync(command, { encoding: 'utf8' });
            console.log(`Batch execution output: ${output.substring(0, 200)}...`);
          } catch (execError) {
            console.error(`Command execution error: ${execError.message}`);
            if (execError.stderr) {
              console.error(`Command stderr: ${execError.stderr}`);
            }
            if (execError.stdout) {
              console.error(`Command stdout: ${execError.stdout}`);
            }
            throw execError;
          }
          
          // Count rows in this batch
          const rowsInBatch = query.split('VALUES')[1].split('),').length;
          successCount += rowsInBatch;
          
          console.log(`Batch ${i+1}/${batches.length} succeeded with ${rowsInBatch} rows`);
        } catch (batchError) {
          console.error(`Error executing batch ${i+1}/${batches.length}, trying with smaller batches:`, batchError.message);
          
          // Check if the error is related to JSON data
          if (batchError.message.includes('JSON') || batchError.message.includes('json')) {
            console.error('Possible JSON formatting issue in the data');
            
            // Log a sample of the data for debugging
            for (let j = 0; j < Math.min(5, rows.length); j++) {
              const row = rows[j];
              console.log(`Sample row ${j+1}: ${JSON.stringify(row)}`);
              
              // Check for potential JSON issues in the data
              for (const value of row) {
                if (typeof value === 'string' && (value.includes('{') || value.includes('['))) {
                  try {
                    JSON.parse(value);
                  } catch (jsonError) {
                    console.error(`Invalid JSON in row ${j+1}: ${value}`);
                    console.error(`JSON parse error: ${jsonError.message}`);
                  }
                }
              }
            }
          }
          
          // If the batch fails, try executing each statement individually
          const rowsInBatch = query.split('VALUES')[1].split('),').length;
          console.log(`Splitting batch into ${rowsInBatch} individual statements`);
          
          // Extract individual statements from the batch
          let individualSuccess = 0;
          for (let j = 0; j < rowsInBatch; j++) {
            try {
              // Create individual statement
              const singleRow = rows[j];
              const singlePlaceholders = Array(singleRow.length).fill('?').join(', ');
              const singleQuery = `${queryPrefix}(${singlePlaceholders});`;
              const singleParams = singleRow;
              
              // Log the row data for debugging
              console.log(`Row ${j+1} data: ${JSON.stringify(singleRow)}`);
              
              const singleParamSql = this.replacePlaceholders(singleQuery, singleParams);
              const singleCommand = `npx wrangler d1 execute ${this.databaseName} --remote --command="${singleParamSql.replace(/"/g, '\"')}"${this.dbPath ? ` --local --database-file=${this.dbPath}` : ''}`;
              
              try {
                execSync(singleCommand, { encoding: 'utf8' });
                individualSuccess++;
              } catch (singleExecError) {
                console.error(`Error executing individual statement ${j+1}: ${singleExecError.message}`);
                if (singleExecError.stderr) {
                  console.error(`Statement stderr: ${singleExecError.stderr}`);
                }
              }
              
              // Log progress periodically
              if (individualSuccess % 10 === 0 || individualSuccess === 1 || individualSuccess === rowsInBatch) {
                console.log(`Individual inserts: ${individualSuccess}/${rowsInBatch} succeeded`);
              }
            } catch (individualError) {
              // Just log and continue to the next statement
              console.error(`Error preparing individual statement ${j+1}/${rowsInBatch}:`, individualError.message);
            }
          }
          
          successCount += individualSuccess;
          console.log(`Individual processing completed: ${individualSuccess}/${rowsInBatch} succeeded`);
        }
      } catch (error) {
        console.error(`Fatal error executing batch ${i+1}/${batches.length}:`, error.message);
        if (error.stack) {
          console.error(`Error stack: ${error.stack}`);
        }
      }
    }
    
    return { successCount };
  }
}

export default D1Client;
