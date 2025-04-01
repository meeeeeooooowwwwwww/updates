#!/bin/bash

# Exit immediately if a command exits with a non-zero status.
set -e

echo "Starting D1 import process..."

# Find all batch files, sort them numerically
# Use 'ls -v' for natural sort (batch_1, batch_2, ..., batch_10, batch_11)
# Or use 'sort -V' if ls -v is not available/reliable
for sql_file in $(ls -v import_batch_*.sql 2>/dev/null || find . -maxdepth 1 -name 'import_batch_*.sql' | sort -V); do
  if [ -f "$sql_file" ]; then
    echo "--------------------------------------------------"
    echo "Executing batch file: $sql_file"
    echo "--------------------------------------------------"
    # Execute the wrangler command for the current file, targeting remote DB
    # Make sure to include --remote!
    wrangler d1 execute nataliewinters-db --remote --file="$sql_file"

    # Check the exit status of the wrangler command
    if [ $? -ne 0 ]; then
      echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
      echo "ERROR: Wrangler command failed for $sql_file."
      echo "Stopping script."
      echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
      exit 1 # Exit the script with an error code
    fi
    echo "Successfully executed $sql_file."
    # Optional: Add a small delay between batches if needed
    # echo "Waiting 1 second..."
    # sleep 1
  else
     echo "Warning: Found non-file entry matching pattern: $sql_file"
  fi
done

echo "--------------------------------------------------"
echo "All import batches executed successfully!"
echo "--------------------------------------------------"

exit 0