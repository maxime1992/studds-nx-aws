import { createBuilder, BuilderContext } from '@angular-devkit/architect';
import { JsonObject } from '@angular-devkit/core';
import { runCloudformationCommand } from '../run-cloudformation-command';
import { sync as mkdirpSync } from 'mkdirp';
import { parse } from 'path';
import { loadCloudFormationTemplate } from '../../utils/load-cloud-formation-template';
import Template from 'cloudform-types/types/template';
import { from } from 'rxjs';
import { switchMap } from 'rxjs/operators';
import { resolve } from 'path';
import { writeFileSync } from 'fs';
import { dump } from 'js-yaml';
import Resource from 'cloudform-types/types/resource';
import { CLOUDFORMATION_SCHEMA } from 'cloudformation-js-yaml-schema';

// todo: allow overriding some / all of these with environment variables
interface IPackageOptions extends JsonObject {
    /**
     * The path where your AWS CloudFormation template is located.
     */
    templateFile: string;
    /**
     *
     */
    outputTemplateFile: string;
    /**
     *
     * The name of the S3 bucket where this command uploads the artefacts that are referenced in your template.
     */
    s3Bucket: string;
    /**
     *  A prefix name that the command adds to the artefacts' name when it uploads them to the S3 bucket. The
     *  prefix name is a path name (folder name) for the S3 bucket.
     */
    s3Prefix: string | null;
    /**
     * If true, we skip the aws package command, which is unnecessary for a sub stack
     */
    subStackOnly: boolean;
}

try {
    require('dotenv').config();
} catch (e) {}

export default createBuilder<IPackageOptions>(
    (options: IPackageOptions, context: BuilderContext) => {
        const cloudFormation = loadCloudFormationTemplate(options.templateFile);
        return from(updateCloudFormationTemplate(cloudFormation, context)).pipe(
            switchMap(async () => {
                const updatedTemplateFile = getFinalTemplateLocation(
                    options.outputTemplateFile,
                    options.templateFile
                );
                options.templateFile = updatedTemplateFile;
                writeFileSync(
                    updatedTemplateFile,
                    dump(cloudFormation, { schema: CLOUDFORMATION_SCHEMA }),
                    {
                        encoding: 'utf-8'
                    }
                );
                if (options.subStackOnly) {
                    // if this is a sub-stack only, we don't need to run package, as the aws cli already
                    // handles nested stacks.
                    return { success: true };
                }
                // todo: probably should use nrwl's command builder (whatever that's called?)
                return runCloudformationCommand(options, context, 'package');
            })
        );
    }
);
async function updateCloudFormationTemplate(
    cloudFormation: Template,
    context: BuilderContext
) {
    const resources = cloudFormation.Resources;
    if (resources) {
        for (const key in resources) {
            if (resources.hasOwnProperty(key)) {
                const resource = resources[key];
                if (resource.Type === 'AWS::Serverless::Application') {
                    await resolveSubStackTemplateLocation(
                        resource,
                        context,
                        key
                    );
                }
            }
        }
    }
}
async function resolveSubStackTemplateLocation(
    resource: Resource,
    context: BuilderContext,
    key: string
) {
    const properties = resource.Properties;
    if (properties) {
        const location = properties.Location;
        const applicationOptions = await context.getTargetOptions({
            project: location,
            target: 'package'
        });
        const outputTemplateFile = applicationOptions.outputTemplateFile;
        const templateFile = applicationOptions.templateFile;
        if (
            isContentfulString(outputTemplateFile) &&
            isContentfulString(templateFile)
        ) {
            // we map the location to the
            const finalTemplateLocation = getFinalTemplateLocation(
                outputTemplateFile,
                templateFile
            );
            context.logger.info(
                `Remapping ${key} location to ${finalTemplateLocation} for referenced project ${location}`
            );
            properties.Location = finalTemplateLocation;
        }
    }
}

/**
 *
 * Get the destination where we'll copy the template
 *
 * @param outputTemplateFile
 * @param templateFile
 */
function getFinalTemplateLocation(
    outputTemplateFile: string,
    templateFile: string
) {
    const dir = parse(outputTemplateFile).dir;
    mkdirpSync(dir);
    const base = parse(templateFile).base;
    const finalTemplateLocation = resolve(dir, base);
    return finalTemplateLocation;
}

function isContentfulString(s: any): s is string {
    return typeof s === 'string' && !!s;
}
