import { Module, File } from "./lang";
import { Target } from "../../target";
import { api10 } from "raml-1-parser";

import * as child from "child_process";
import * as path from "path";
import * as fs from "fs";

/**
 * Uppercases the first character in the string.
 */
function upperFirst(str: string): string {
    return str.slice(0, 1).toUpperCase() + str.slice(1);
}

/**
 * A map of terms which should have their cased versions treated specially.
 */
const capitalizations = [
    { needle: /Id/g, replace: "ID" },
    { needle: /Oauth/g, replace: "OAuth" },
];

/**
 * Fixes capitalizations
 */
function fixCaps(str: string): string {
    capitalizations.forEach(cap => {
        str = str.replace(cap.needle, cap.replace);
    });

    return str;
}

export class GoTarget implements Target {

    check(): Promise<void> {
        return Promise.resolve();
    }

    /**
     * Returns the Go type for a RAML type string.
     */
    private translateTypeString(str: string): string {
        if (str.endsWith("[]")) {
            return `[]${this.translateTypeString(str.slice(0, -2))}`;
        }

        if (str.indexOf("|") !== -1) {
            return `interface{}`;
        }

        switch (str) {
        case "string":              return "string";
        case "integer":
        case "number":              return "int";
        case "uint":                return "uint";
        case "boolean":             return "bool";
        case "object":              return "map[string]interface{}";
        case "IsoDate":             return "time.Time";
        case "UnixTimestampMillis": return "time.Time";
        }

        return str;
    }

    /**
     * Returns the Go type for a RAML type declaration.
     */
    private translateType(type: api10.TypeDeclaration): string {
        let out = "";
        if (!type.required()) {
            out += "*";
        }

        let primary = type.type()[0];
        if (primary === "array") {
            out += "[]";
            primary = (<api10.ArrayTypeDeclaration>type).items().type()[0];
        }

        out += this.translateTypeString(primary);

        return fixCaps(out);
    }

    /**
     * Returns the internal, Go name for a JavaScript property.
     */
    private translatePropName(name: string, isExported: boolean=true): string {
        name = name.split(/[^a-z0-9]+/ig)
            .map((str, i) => (i > 0 || isExported) ? upperFirst(str) : str)
            .join('');

        if (name === "type") {
            name = "kind";
        }

        return fixCaps(name);
    }

    /**
     * Creates a models.go file containing objects from the API.
     */
    private createModels(api: api10.Api, file: File) {
        api.types().forEach(type => {
            if (!("properties" in type)) {
                return;
            }

            this.generateStruct(file, api, type.name(), <api10.ObjectTypeDeclaration>type);
        });
    }

    private inferMethodName(resource: api10.Resource, method: api10.Method): string {
        if (method.displayName() !== null) {
            return method.displayName();
        }

        let parts = resource.absoluteUri()
            .split("/")
            .filter(seg => !(/^\{.+\}$/).test(seg))
            .map(part => upperFirst(part))
            .slice(5)
            .join("")
            .replace(/[^a-z0-9]/ig, "")

        parts = fixCaps(parts);

        switch (method.method()) {
        case "get":    return `Get${parts}`;
        case "post":   return `Create${parts}`;
        case "put":
        case "patch":  return `Update${parts}`;
        case "delete": return `Delete${parts}`;
        }

        return "UNKNOWN";
    }

    /**
     * Writes a struct containing the specified list of types to standard
     * output.
     */
    private generateStruct(file: File, api: api10.Api,
        name: string, type: api10.ObjectTypeDeclaration) {

        const struct = file.struct(name);

        /**
         * Returns an object containing a map of property names to their
         * Go type declarations, for the given RAML type declaration.
         */
        const generateTypesFor = (type: api10.TypeDeclaration) => {
            if (!("properties" in type)) {
                return {};
            }

            const objType = <api10.ObjectTypeDeclaration>type;
            const declaration : { [prop:string]: string } = {};
            objType.properties().forEach(prop => {
                struct.field(
                    this.translatePropName(prop.name()),
                    this.translateType(prop),
                    `json:"${prop.name()}"`
                );
            });

            objType.type().forEach(subtype => {
                api.types().some(type => {
                    if (type.name() === subtype) {
                        generateTypesFor(type);
                        return true;
                    }
                });
            });
        };
    }

    private createEndpoints(api: api10.Api, file: File) {
        file.import("http").import("fmt");

        enum ReqStructKind {
            Payload = 0,
            Params
        }

        const generateReqStruct = (name: string, kind: ReqStructKind, types: Array<api10.TypeDeclaration>): string => {
            const primary = types.length && types[0].name();
            const convert = primary && this.translateTypeString(primary);
            if (primary && file.module.getIdentifier(convert)) {
                return convert;
            }

            const struct = file.struct(name);
            types.forEach(prop => {
                struct.field(
                    this.translatePropName(prop.name()),
                    this.translateTypeString(prop.type()[0]),
                    `${(kind === ReqStructKind.Params ? "url" : "json")}:"${prop.name()}"`
                );
            });

            return name;
        };

        const generateMethods = (resource: api10.Resource) => {

            let fmtParams = [`"${resource.absoluteUri().replace("{version}", "1")}"`];
            let methodArgs = new Array<{name: string, type: string}>();

            resource.absoluteUriParameters().slice(1).forEach((param, i) => {
                let argName = this.translatePropName(param.name(), false);

                fmtParams[0] = fmtParams[0].replace(`{${param.name()}}`,
                    param.type()[0] === "number" ? "%d" : "%s");
                fmtParams.push(argName);
                methodArgs.push({ name: argName, type: this.translateType(param) });
            });

            resource.methods().forEach(method => {
                const methodName = this.inferMethodName(resource, method);
                const builder = file.func(methodName).methodOf("c *Client");

                let queryParams = method.queryParameters();
                let body = method.body();
                method.is().forEach(trait => {
                    queryParams = queryParams.concat(trait.trait().queryParameters());
                    body = body.concat(trait.trait().body());
                });

                methodArgs.forEach(arg => {
                    builder.arg(arg.name, arg.type);
                });

                if (body.length) {
                    builder.arg("payload", generateReqStruct(
                        `${methodName}Payload`,
                        ReqStructKind.Payload,
                        body
                    ));
                }

                if (queryParams.length) {
                    builder.arg("params", generateReqStruct(
                        `${methodName}Params`,
                        ReqStructKind.Params,
                        queryParams
                    ));
                }

                builder.returns("*http.Response");
                const goodRes = method.responses().find(res => Number(res.code().value()) < 300);
                let resType : string;
                if (goodRes && goodRes.body().length > 0) {
                    resType = this.translateType(goodRes.body()[0]);
                    builder.returns(resType);
                }
                builder.returns("error");

                let request = `Method: "${method.method()}",
                    URL: fmt.Sprintf(${fmtParams.join(", ")}) + "?" + q,
                `;
                let response = ``;

                if (body) {
                    file.import("bytes").import("encoding/json");
                    request += `Body: bytes.NewReader(body),
                        ContentLength: len(body),
                        Header: http.Header{
                            "Content-Type": {"application/json"},
                        },
                    `;

                    builder.write(`
                        body, err := json.Marshal(payload)
                        if err != nil {
                            return err
                        }
                    `);
                }

                if (queryParams) {
                    file.import("github.com/google/go-querystring");
                    builder.write(`
                        q, err := query.Values(params)
                        if err != nil {
                            return err
                        }
                    `);
                } else {
                    builder.write(`
                        q := ""
                    `);
                }

                builder.write(`
                    res, err := c.do(&http.Request{${request}})
                `);

                if (resType) {
                    builder.write(`
                        if err != nil || res.StatusCode >= 300 {
                            return res, ${resType ? "nil, " : ""}err
                        }

                        var typ ${resType}
                        if err := json.NewDecoder(res.Body).Decode(&typ); err != nil {
                            return err
                        }

                        return res, typ, nil
                    `);
                } else {
                    builder.write(`
                        return res, err
                    `);
                }
            });

            resource.resources().forEach(generateMethods);
        };

        api.resources().forEach(generateMethods);
    }

    generate(api: api10.Api, output: string): Promise<void> {
        const module = new Module(output, "client");

        this.createEndpoints(api, module.file("models.go"));
        this.createEndpoints(api, module.file("endpoints.go"));

        return module.save();
    }
}

export default new GoTarget();