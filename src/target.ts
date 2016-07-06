import { api10, api08 } from "raml-1-parser";


export interface GenerateArgs {
    API: api10.Api,
    Output: string
}

export interface Target {

    /**
     * Check ensures that depedencies needed to run the
     * target generator are installed.
     */
    check(): Promise<void>

    /**
     * Runs generation for the provided API and outputs associated
     * files into the target "output" directory.
     */
    generate(api: api10.Api, output: string): Promise<void>
}