import { Command } from 'commander';
import { upgradeCvm, getCvmByAppId, selectCvm, checkCvmExists } from '@/src/api/cvms';
import { logger } from '@/src/utils/logger';
import fs from 'node:fs';
import { detectFileInCurrentDir, promptForFile } from '@/src/utils/prompts';
import { parseEnv } from '@/src/utils/secrets';
import { encryptEnvVars, type EnvVar } from '@phala/dstack-sdk/encrypt-env-vars';
import { deleteSimulatorEndpointEnv } from '@/src/utils/simulator';
import { resolveCvmAppId } from '@/src/utils/cvms';
import { CLOUD_URL } from '@/src/utils/constants';

export const upgradeCommand = new Command()
  .name('upgrade')
  .description('Upgrade a CVM to a new version')
  .argument('[app-id]', 'CVM app ID to upgrade (will prompt for selection if not provided)')
  .option('-c, --compose <compose>', 'Path to new Docker Compose file')
  .option('-e, --env-file <envFile>', 'Path to environment file')
  .option('--debug', 'Enable debug mode', false)
  .action(async (appId, options) => {
    try {
      const resolvedAppId = await resolveCvmAppId(appId);

      // Get current CVM configuration
      const spinner = logger.startSpinner(`Fetching current configuration for CVM app_${resolvedAppId}`);
      const currentCvm = await getCvmByAppId(resolvedAppId);
      spinner.stop(true);
      
      if (!currentCvm) {
        logger.error(`CVM with App ID app_${resolvedAppId} not found`);
        process.exit(1);
      }
      
      // If compose path not provided, prompt with examples
      if (!options.compose) {
        const possibleFiles = ['docker-compose.yml', 'docker-compose.yaml'];
        const composeFileName = detectFileInCurrentDir(possibleFiles, 'Detected docker compose file: {path}');
        
        options.compose = await promptForFile(
          'Enter the path to your Docker Compose file:',
          composeFileName,
          'file'
        );
      }
      
      // Update Docker Compose file if provided
      let composeString = '';
      if (options.compose) {
        try {
          composeString = fs.readFileSync(options.compose, 'utf8');
        } catch (error) {
          logger.error(`Failed to read Docker Compose file: ${error instanceof Error ? error.message : String(error)}`);
          process.exit(1);
        }
      }
      
      // Delete DSTACK_SIMULATOR_ENDPOINT environment variable
      await deleteSimulatorEndpointEnv();

      // Process environment variables if provided
      let encrypted_env = "";
      if (options.envFile) {
        let envs: EnvVar[] = [];
        
        // Process environment variables from file
        if (options.envFile) {
          try {
            envs = parseEnv([], options.envFile);
            encrypted_env = await encryptEnvVars(envs, currentCvm.encrypted_env_pubkey);
          } catch (error) {
            logger.error(`Failed to read environment file: ${error instanceof Error ? error.message : String(error)}`);
            process.exit(1);
          }
        }
        
      }

      const vm_config = {
        compose_manifest: {
          docker_compose_file: composeString,
          manifest_version: 1,
          runner: "docker-compose",
          version: "1.0.0",
          features: ["kms", "tproxy-net"],
          name: `app_${resolvedAppId}`,
        },
        encrypted_env,
        allow_restart: true,
      };
      
      // Upgrade the CVM
      const upgradeSpinner = logger.startSpinner(`Upgrading CVM app_${resolvedAppId}`);
      const response = await upgradeCvm(resolvedAppId, vm_config);
      
      if (!response) {
        upgradeSpinner.stop(false);
        logger.error('Failed to upgrade CVM');
        process.exit(1);
      }
      upgradeSpinner.stop(true);

      if (response.detail) {
        logger.info(`Details: ${response.detail}`);
      }

      logger.break();
      logger.success(
        `Your CVM is being upgraded. You can check the dashboard for more details:\n${CLOUD_URL}/dashboard/cvms/app_${resolvedAppId}`
      );
    } catch (error) {
      logger.error(`Failed to upgrade CVM: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  }); 