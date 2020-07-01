// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import _ from "lodash";
import Guard from "../common/guard";
import {
    IAsset, AssetType, IProject, IAssetMetadata, AssetState,
    ILabelData, ILabel, ITag, IGeneratorRegion, IGenerator, RegionType, NamedItem
} from "../models/applicationState";
import { AssetProviderFactory, IAssetProvider } from "../providers/storage/assetProviderFactory";
import { StorageProviderFactory, IStorageProvider } from "../providers/storage/storageProviderFactory";
import { constants } from "../common/constants";
import { appInfo } from "../common/appInfo";
import { encodeFileURI } from "../common/utils";
import { strings, interpolate } from "../common/strings";
import { sha256Hash } from "../common/crypto";
import { toast } from "react-toastify";
import { generateBlobSASQueryParameters } from "@azure/storage-blob";

const supportedImageFormats = {
    jpg: null, jpeg: null, null: null, png: null, bmp: null, tif: null, tiff: null, pdf: null,
};

interface IMime {
    types: string[];
    pattern: (number|undefined)[];
}

  // tslint:disable number-literal-format
  // tslint:disable no-magic-numbers
const imageMimes: IMime[] = [
    {
        types: ["bmp"],
        pattern: [0x42, 0x4d],
    },
    {
        types: ["png"],
        pattern: [0x89, 0x50, 0x4e, 0x47],
    },
    {
        types: ["jpeg", "jpg"],
        pattern: [0xff, 0xd8, 0xff],
    },
    {
        types: ["tif", "tiff"],
        pattern: [0x49, 0x49, 0x42, 0x00],
    },
    {
        types: ["pdf"],
        pattern: [0x25, 0x50, 0x44, 0x46, 0x2d],
    },
];
// We can expand this list @see https://mimesniff.spec.whatwg.org/#matching-an-image-type-pattern
const mimeBytesNeeded: number = (Math.max(...imageMimes.map((m) => m.pattern.length)) - 1);

/**
 * @name - Asset Service
 * @description - Functions for dealing with project assets
 */
export class AssetService {
    /**
     * Create IAsset from filePath
     * @param filePath - filepath of asset
     * @param fileName - name of asset
     */
    public static async createAssetFromFilePath(filePath: string, fileName?: string): Promise<IAsset> {
        Guard.empty(filePath);

        const normalizedPath = filePath.toLowerCase();

        // If the path is not already prefixed with a protocol
        // then assume it comes from the local file system
        if (!normalizedPath.startsWith("http://") &&
            !normalizedPath.startsWith("https://") &&
            !normalizedPath.startsWith("file:")) {
            // First replace \ character with / the do the standard url encoding then encode unsupported characters
            filePath = encodeFileURI(filePath, true);
        }

        const hash = await sha256Hash(filePath);
        // eslint-disable-next-line
        const pathParts = filePath.split(/[\\\/]/);
        fileName = fileName || pathParts[pathParts.length - 1];
        const fileNameParts = fileName.split(".");

        // eslint-disable-next-line
        const extensionParts = fileNameParts[fileNameParts.length - 1].split(/[\?#]/);
        let assetFormat = extensionParts[0].toLowerCase();

        if (supportedImageFormats.hasOwnProperty(assetFormat)) {
            const types = await this.getMimeType(filePath);

            // If file was renamed/spoofed - fix file extension to true MIME type and show message
            if (!types.includes(assetFormat)) {
                assetFormat = types[0];
                const corruptFileName = fileName.split("%2F").pop().replace(/%20/g, " ");
                setTimeout(() => {
                    toast.info(`${strings.editorPage.assetWarning.incorrectFileExtension.attention} ${corruptFileName.toLocaleUpperCase()} ${strings.editorPage.assetWarning.incorrectFileExtension.text} ${corruptFileName.toLocaleUpperCase()}`);
                }, 3000);
            }
        }

        const assetType = this.getAssetType(assetFormat);

        return {
            id: hash,
            format: assetFormat,
            state: AssetState.NotVisited,
            type: assetType,
            name: fileName,
            path: filePath,
            size: null,
        };
    }

    /**
     * Get Asset Type from format (file extension)
     * @param format - File extension of asset
     */
    public static getAssetType(format: string): AssetType {
        switch (format.toLowerCase()) {
            case "jpg":
            case "jpeg":
            case "png":
            case "bmp":
                return AssetType.Image;
            case "tif":
            case "tiff":
                return AssetType.TIFF;
            case "pdf":
                return AssetType.PDF;
            default:
                return AssetType.Unknown;
        }
    }

    // If extension of a file was spoofed, we fetch only first 4 bytes of the file and read MIME type
    public static async getMimeType(uri: string): Promise<string[]> {
        const first4bytes: Response = await fetch(uri, { headers: { range: `bytes=0-${mimeBytesNeeded}` } });
        const arrayBuffer: ArrayBuffer = await first4bytes.arrayBuffer();
        const blob = new Blob([new Uint8Array(arrayBuffer).buffer]);
        const isMime = (bytes: Uint8Array, mime: IMime): boolean => {
                return mime.pattern.every((p, i) => !p || bytes[i] === p);
        };
        const fileReader: FileReader = new FileReader();

        return new Promise<string[]>((resolve, reject) => {
            fileReader.onloadend = (e) => {
                if (!e || !fileReader.result) {
                    return [];
                }
                const bytes: Uint8Array = new Uint8Array(fileReader.result as ArrayBuffer);
                const type: string[] = imageMimes.filter((mime) => isMime(bytes, mime))?.[0]?.types;
                resolve(type || []);
            };
            fileReader.readAsArrayBuffer(blob);
        });
    }

    public static emptyLabelData: (assetName: string) => ILabelData  = (assetName: string) => {
        return {
            document: decodeURIComponent(assetName).split("/").pop(),
            labels: [],
        };
    }

    private assetProviderInstance: IAssetProvider;
    private storageProviderInstance: IStorageProvider;

    constructor(private project: IProject) {
        Guard.null(project);
    }

    /**
     * Get Asset Provider from project's source connection
     */
    protected get assetProvider(): IAssetProvider {
        if (!this.assetProviderInstance) {
            this.assetProviderInstance = AssetProviderFactory.create(
                this.project.sourceConnection.providerType,
                this.project.sourceConnection.providerOptions,
            );
        }

        return this.assetProviderInstance;
    }

    /**
     * Get Storage Provider from project's target connection
     * TODO: some better abstraction for project storage manipulation
     */
    public get storageProvider(): IStorageProvider {
        if (!this.storageProviderInstance) {
            this.storageProviderInstance = StorageProviderFactory.create(
                this.project.sourceConnection.providerType,
                this.project.sourceConnection.providerOptions,
            );
        }

        return this.storageProviderInstance;
    }

    /**
     * Get assets from provider
     */
    public async getAssets(): Promise<IAsset[]> {
        const folderPath = this.project.folderPath;
        const assets = await this.assetProvider.getAssets(folderPath);
        const returnedAssets = assets.map((asset) => {
            asset.name = decodeURIComponent(asset.name);
            return asset;
        }).filter((asset) => this.isInExactFolderPath(asset.name, folderPath));

        return returnedAssets;
    }

    private getLabelFilename = (asset: IAsset) => {
        return decodeURIComponent(`${asset.name}${constants.labelFileExtension}`);
    }

    private getGeneratorFilename = (asset: IAsset) => {
        return decodeURIComponent(`${asset.name}${constants.generatorFileExtension}`);
    }

    private getOCRFilename = (asset: IAsset) => {
        return decodeURIComponent(`${asset.name}${constants.ocrFileExtension}`);
    }

    /**
     * Save metadata for asset
     * @param metadata - Metadata for asset
     */
    public async save(metadata: IAssetMetadata): Promise<IAssetMetadata> {
        Guard.null(metadata);

        const labelFileName = this.getLabelFilename(metadata.asset);
        if (metadata.asset.state !== AssetState.Tagged) {
            // If the asset is no longer tagged, then it doesn't contain any regions
            // and the file is not required.
            try {
                await this.storageProvider.deleteFile(labelFileName, true, true);
            } catch (err) {
                // The file may not exist - that's OK.
            }
        } else if (metadata.labelData) {
            await this.saveLabels(metadata.asset, metadata.labelData);
        }

        await this.saveGenerators(metadata);

        return metadata;
    }

    public async saveLabels(asset: IAsset, labelData: ILabelData, prefix: string = "") {
        /**
         * prefix: override for asset prefix
         */
        let filepath = this.getLabelFilename(asset);
        if (prefix.length > 0) {
            const filename = filepath.split("/").slice(-1)[0];
            filepath = prefix.concat(filename);
        }
        // TODO do we care about decodeURI in the filename?

        return await this.storageProvider.writeText(filepath, JSON.stringify(labelData, null, 4));
    }

    public async saveOCR(asset: IAsset, ocr: any, prefix: string = "") {
        /**
         * prefix: override for asset prefix
         */
        let filepath = this.getOCRFilename(asset);
        if (prefix.length > 0) {
            const filename = filepath.split("/").slice(-1)[0];
            filepath = prefix.concat(filename);
        }
        // TODO do we care about decodeURI in the filename?

        return await this.storageProvider.writeText(filepath, JSON.stringify(ocr, null, 4));
    }

    public async saveGenerators(metadata: IAssetMetadata): Promise<void> {
        Guard.null(metadata);
        // Generators
        // TODO ideally we would make separate calls for lightweight settings change and generators
        const generatorFilename = this.getGeneratorFilename(metadata.asset);
        if (metadata.generators || metadata.generatorSettings) {
            const generatorData = {
                generators: metadata.generators,
                generatorSettings: metadata.generatorSettings,
            };
            await this.storageProvider.writeText(generatorFilename, JSON.stringify(generatorData, null, 4));
        }

        // TODO deletion logic
        return;
    }

    /**
     * Get metadata for asset
     * @param asset - Asset for which to retrieve metadata
     */
    public async getAssetMetadata(asset: IAsset): Promise<IAssetMetadata> {
        Guard.null(asset);
        let assetMetadata: IAssetMetadata = {
            asset: { ...asset },
            regions: [], // No region information is stored
            generators: [],
            generatorSettings: {
                generateCount: 40
            },
            version: appInfo.version,
            labelData: null,
        };
        const labelFilename = this.getLabelFilename(asset);
        // TODO parallelize
        assetMetadata.labelData = await this.getLabelDataFromJSON(labelFilename, asset);
        const generatorFilename = this.getGeneratorFilename(asset);
        const generatorUpdate = await this.getGeneratorDataFromJSON(generatorFilename);
        // ! Hack to write to tags
        assetMetadata = {...assetMetadata, ...generatorUpdate};
        return assetMetadata;
    }

    private async getLabelDataFromJSON(labelFileName: string, asset: IAsset): Promise<ILabelData> {
        try {
            const json = await this.storageProvider.readText(labelFileName, true);
            const labelData = JSON.parse(json) as ILabelData;
            if (!labelData.document || !labelData.labels) {
                const reason = interpolate(strings.errors.missingRequiredFieldInLabelFile.message, { labelFileName });
                toast.error(reason, { autoClose: false });
                throw new Error("Invalid label file");
            }
            if (labelData.labels.length === 0) {
                const reason = interpolate(strings.errors.noLabelInLabelFile.message, { labelFileName });
                toast.info(reason);
                throw new Error("Empty label file");
            }
            if (labelData.labels.find((f) => f.label.trim().length === 0)) {
                toast.error(strings.tags.warnings.emptyName, { autoClose: false });
                throw new Error("Invalid label file");
            }
            if (labelData.labels.containsDuplicates<ILabel>((f) => f.label)) {
                const reason = interpolate(strings.errors.duplicateFieldKeyInLabelsFile.message, { labelFileName });
                toast.error(reason, { autoClose: false });
                throw new Error("Invalid label file");
            }
            const labelHash = new Set<string>();
            for (const label of labelData.labels) {
                const pageSet = new Set<number>();
                for (const valueObj of label.value) {
                    if (pageSet.size !== 0 && !pageSet.has(valueObj.page)) {
                        const reason = interpolate(
                            strings.errors.sameLabelInDifferentPageError.message, { tagName: label.label });
                        toast.error(reason, { autoClose: false });
                        throw new Error("Invalid label file");
                    }
                    pageSet.add(valueObj.page);
                    for (const box of valueObj.boundingBoxes) {
                        const hash = [valueObj.page, ...box].join();
                        if (labelHash.has(hash)) {
                            const reason = interpolate(
                                strings.errors.duplicateBoxInLabelFile.message, { page: valueObj.page });
                            toast.error(reason, { autoClose: false });
                            throw new Error("Invalid label file");
                        }
                        labelHash.add(hash);
                    }
                }
            }
            toast.dismiss();
            return labelData;
        } catch (err) {
            if (err instanceof SyntaxError) {
                const reason = interpolate(strings.errors.invalidJSONFormat.message, { labelFileName });
                toast.error(reason, { autoClose: false });
                return null;
            }
            return AssetService.emptyLabelData(asset.name);
        }
    }

    private async getGeneratorDataFromJSON(filename): Promise<Partial<IAssetMetadata>> {
        try {
            const json = await this.storageProvider.readText(filename, true);
            const generatorData = JSON.parse(json) as Partial<IAssetMetadata>;
            if (!generatorData.generators || !generatorData.generatorSettings) {
                // TODO custom warnings
                const reason = interpolate(strings.errors.missingRequiredFieldInLabelFile.message, { filename });
                toast.error(reason, { autoClose: false });
                throw new Error("Invalid generator file");
            }
            // TODO use a separate json validator
            // TODO validate generators

            // TODO validate generator settings
            // TODO multiple page support
            // ! Hack to convert form old format
            generatorData.generators.forEach((g: any) => {
                if (!g.tag) {
                    g.tag = {
                        color: g.color,
                        type: g.type,
                        format: g.format,
                        name: g.name
                    }
                }
            })

            toast.dismiss();
            return generatorData;
        } catch (err) {
            if (err instanceof SyntaxError) {
                const reason = interpolate(strings.errors.invalidJSONFormat.message, { filename });
                toast.error(reason, { autoClose: false });
            }
            return {};
        }
    }

    /**
     * Delete a tag from asset metadata files
     * @param tagName Name of tag to delete
     */
    public async deleteTag(tagName: string): Promise<IAssetMetadata[]> {
        const transformer = (tagNames) => tagNames.filter((t) => t !== tagName);
        const labelTransformer = (labelData: ILabelData) => {
            labelData.labels = labelData.labels.filter((label) => label.label !== tagName);
            return labelData;
        };
        const generatorTransformer = (generator: IGenerator) => {
            return generator.tag?.name === tagName ? {
                ...generator,
                tag: null
            } : generator;
        }
        return await this.getUpdatedAssets(
            tagName,
            transformer,
            labelTransformer,
            generatorTransformer
        );
    }

    /**
     * Rename a tag within asset metadata files
     * @param tagName Name of tag to rename
     * @param newTagName New name
     */
    public async renameTag(tagName: string, newTagName: string): Promise<IAssetMetadata[]> {
        return await this.updateTag({name: tagName}, {name: newTagName});
    }

    /**
     * Update tag within asset metadata files
     * Note: this doesn't save it, just fetches metadata and applies changes (see saveAssetMetadata)
     * @param oldTag old tag info
     * @param newTag new tag info (should share the same keys)
     */
    public async updateTag(oldTag: NamedItem & Partial<ITag>, newTag: NamedItem & Partial<ITag>): Promise<IAssetMetadata[]> {
        let transformer;
        let labelTransformer;
        // transformer (for regions) and label transformer only update name
        if (oldTag.name !== newTag.name) {
            transformer = (tags) => tags.map((t) => (t === oldTag.name) ? newTag.name : t);
            labelTransformer =  (labelData: ILabelData) => {
                const field = labelData.labels.find((label) => label.label === oldTag.name);
                if (field) {
                    field.label = newTag.name;
                }
                return labelData;
            };
        }

        // generator updates everything
        const generatorTransformer = (generator: IGenerator) => {
            return generator.tag?.name === oldTag.name ? {
                ...generator, tag: { ...generator.tag, ...newTag}
            } : generator;
        }

        return await this.getUpdatedAssets(
            oldTag.name,
            transformer,
            labelTransformer,
            generatorTransformer
        );
    }

    /**
     * Update tags within asset metadata files
     * @param tagName Name of tag to update within project
     * @param transformer Function that accepts array of tags from a region and returns a modified array of tags
     */
    private async getUpdatedAssets(
        tagName: string,
        transformer: (tags: string[]) => string[],
        labelTransformer: (label: ILabelData) => ILabelData,
        generatorTransformer: (g: IGenerator) => IGenerator)
        : Promise<IAssetMetadata[]> {
        // Loop over assets and update if necessary
        const updates = await _.values(this.project.assets).mapAsync(async (asset) => {
            const assetMetadata = await this.getAssetMetadata(asset);
            const isUpdated = this.updateTagInAssetMetadata(
                assetMetadata,
                tagName,
                transformer,
                labelTransformer,
                generatorTransformer
            );

            return isUpdated ? assetMetadata : null;
        });

        return updates.filter((assetMetadata) => !!assetMetadata);
    }

    /**
     * Update tag within asset metadata object
     * @param assetMetadata Asset metadata to update
     * @param tagName Name of tag being updated
     * @param transformer Function that accepts array of tags from a region and returns a modified array of tags
     * @returns Modified asset metadata object or null if object does not need to be modified
     */
    private updateTagInAssetMetadata(
        assetMetadata: IAssetMetadata,
        tagName: string,
        transformer: (tags: string[]) => string[],
        labelTransformer: (labelData: ILabelData) => ILabelData,
        generatorTransformer: (g: IGenerator) => IGenerator): boolean {
        let foundTag = false;

        if (!!transformer) {
            for (const region of assetMetadata.regions) {
                if (region.tags.find((t) => t === tagName)) {
                    foundTag = true;
                    region.tags = transformer(region.tags);
                }
            }
        }

        if (!!labelTransformer && assetMetadata.labelData && assetMetadata.labelData.labels) {
            const field = assetMetadata.labelData.labels.find((field) => field.label === tagName);
            if (field) {
                foundTag = true;
                assetMetadata.labelData = labelTransformer(assetMetadata.labelData);
            }
        }

        const oldGenerators = assetMetadata.generators;
        assetMetadata.generators = assetMetadata.generators.map(generatorTransformer);

        if (foundTag) {
            assetMetadata.regions = assetMetadata.regions.filter((region) => region.tags.length > 0);
            assetMetadata.asset.state = _.get(assetMetadata, "labelData.labels.length")
                ? AssetState.Tagged : AssetState.Visited;
            return true;
        }

        if (oldGenerators.some((g, i) => g.tag?.name === tagName)) {
            return true;
        }
        return false;
    }

    private isInExactFolderPath = (assetName: string, normalizedPath: string): boolean => {
        if (normalizedPath === "") {
            return assetName.lastIndexOf("/") === -1;
        }

        const startsWithFolderPath = assetName.indexOf(`${normalizedPath}/`) === 0;
        return startsWithFolderPath && assetName.lastIndexOf("/") === normalizedPath.length;
    }
}
