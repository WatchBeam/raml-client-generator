import { Module, File, Func, Arg, Call, Struct } from "./lang";
import { WriteCollector } from "./util";
import { Target } from "../../target";
import { Todo } from "../../todo";
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

/**
 * Returns the Go type for a RAML type string.
 */
function translateTypeString(str: string): string {
    if (str.endsWith("[]")) {
        return `[]${translateTypeString(str.slice(0, -2))}`;
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
    case "file":                return "io.Reader";
    case "IsoDate":             return "time.Time";
    case "UnixTimestampMillis": return "time.Time";
    }

    return str;
}

/**
 * Returns the Go type for a RAML type declaration.
 */
function translateType(type: api10.TypeDeclaration): string {
    let out = "";
    if (!type.required()) {
        out += "*";
    }

    let primary = type.type()[0];
    if (primary === "array") {
        out += "[]";
        primary = (<api10.ArrayTypeDeclaration>type).items().type()[0];
    }

    out += translateTypeString(primary);

    return fixCaps(out);
}

/**
 * Returns the internal, Go name for a JavaScript property.
 */
function translatePropName(name: string, isExported: boolean=true): string {
    name = name.split(/[^a-z0-9]+/ig)
        .map((str, i) => (i > 0 || isExported) ? upperFirst(str) : str)
        .join('');

    if (name === "type") {
        name = "kind";
    }

    return fixCaps(name);
}

/**
 * Finds the successful response for a method.
 */
function getSuccessfulResponse(method: api10.Method): api10.Response {
    return method.responses().find(res => Number(res.code().value()) < 300);
}

/**
 * Generates a method name to query the method on the specified resource.
 */
function inferMethodName(resource: api10.Resource, method: api10.Method): string {
    if (method.displayName() !== null) {
        return method.displayName();
    }

    let parts = resource.absoluteUri()
        .split("/")
        .filter(seg => !(/^\{.+\}$/).test(seg))
        .map(part => upperFirst(part))
        .slice(5);

    const sr = getSuccessfulResponse(method);
    const primary = sr && sr.body().length && sr.body()[0].type()[0];
    if (primary && primary[0].toUpperCase() === primary[0]) {
        parts[parts.length - 1] = primary;
    }

    const tail = fixCaps(parts.join("").replace(/[^a-z0-9]/ig, ""));

    switch (method.method()) {
    case "get":    return `Get${tail}`;
    case "post":   return `Create${tail}`;
    case "put":
    case "patch":  return `Update${tail}`;
    case "delete": return `Delete${tail}`;
    }

    return "UNKNOWN";
}

/**
 * Writes a struct containing the specified list of types to standard
 * output.
 */
function generateStruct(file: File, api: api10.Api, name: string, type: api10.ObjectTypeDeclaration) {

    const struct = file.struct(name);

    (function gen(type: api10.TypeDeclaration) {
        if (!("properties" in type)) {
            return;
        }

        const objType = <api10.ObjectTypeDeclaration>type;
        const declaration : { [prop:string]: string } = {};
        objType.properties().forEach(prop => {
            struct.field(
                translatePropName(prop.name()),
                translateType(prop),
                `json:"${prop.name()}"`
            );
        });

        objType.type().forEach(subtype => {
            api.types().some(type => {
                if (type.name() === subtype) {
                    gen(type);
                    return true;
                }
            });
        });
    })(type);
}

enum ReqStructKind {
    Payload = 0,
    Params
}

/**
 * Request is a class that generates a function to make a request against
 * a particular endpoint.
 */
class Request {

    private func : Func;
    private options : WriteCollector;
    private before : WriteCollector;
    private after : WriteCollector;

    constructor(private file: File, private resource: api10.Resource) {}

    /**
     * Returns an array of arguments used to format the query string call.
     */
    private getPathFmtArgs(): Array<Arg> {
        return this.resource.absoluteUriParameters().slice(1).map(param => {
            return new Arg(
                translatePropName(param.name(), false),
                translateType(param)
            );
        });
    }

    /**
     * Returns a string for the method call to fmt.Sprintf to generate
     * the path to query.
     */
    private getPathFmtCall(): string {
        let uri = this.resource.absoluteUri().replace("{version}", "1");
        const args = this.getPathFmtArgs();
        if (args.length === 0) {
            return `"${uri}" + q`;
        }

        this.file.import("fmt");
        this.resource.absoluteUriParameters().slice(1).forEach(param => {
            uri = uri.replace(`{${param.name()}}`, param.type()[0] === "number" ? "%d" : "%s");
        });

        args.unshift(new Arg(`"${uri}"`, "string"));
        return new Call("fmt.Sprintf", ...args).toString().trim() + " + q";
    }

    /**
     * Adds query parameter initializations to the current request, if needed.
     */
    private generateQueryParams(method: api10.Method) {
        const queryParams = method.is().reduce(
            (params, trait) => params.concat(trait.trait().queryParameters()),
            method.queryParameters()
        );

        if (queryParams.length === 0) {
            this.before.write(`q := ""\n`)
            return;
        }

        this.file.import("net/url");

        const type = `${this.func.getName()}Params`;
        const struct = this.file.struct(type);
        this.func.arg("query", type);
        this.before.write(`v := url.Values{}\n`)

        queryParams.forEach(prop => {
            const propName = translatePropName(prop.name())
            struct.field(propName, translateTypeString(prop.type()[0]));
            this.before.write(`v.Set("${prop.name()}", query.${propName})\n`)
        });
        this.before.write(`q := "?" + v.Encode()\n`)
    }

    private generateBodyParams(method: api10.Method) {
        const resolved = {};
        const body = <api10.ObjectTypeDeclaration>method.is().reduce(
            (params, trait) => params.concat(trait.trait().body()),
            method.body()
        ).shift();

        if (!body) {
            return;
        }

        switch (body.displayName()) {
        case "application/json":
            let type = translateTypeString(body.type()[0]);
            if (!this.file.module.getIdentifier(type)) {
                type = `${this.func.getName()}Payload`;
                generateStruct(this.file, method.ownerApi(), type, body);
            }

            this.func.arg("payload", type);
            this.file.import("bytes").import("encoding/json");
            this.before.write(`
                body, err := json.Marshal(payload)
                if err != nil {
                    return err
                }
            `);
            this.options.write(`
                Body: bytes.NewReader(body),
                ContentLength: len(body),
                Header: http.Header{"Content-Type": {"application/json"}},
            `);
        break;
        case "multipart/form-data":
            // todo
        break;
        default:
            console.error("Unknown body type:", body.toJSON());
        }
    }

    /**
     * Generates the post-request serialization and return values for
     * the function under construction.
     */
    private generateFuncReturns(method: api10.Method) {
        const goodRes = getSuccessfulResponse(method);
        let resType : string;

        this.func.returns("*http.Response");
        if (goodRes && goodRes.body().length > 0) {
            resType = translateType(goodRes.body()[0]);
            this.func.returns(resType);
        }
        this.func.returns("error");

        if (!goodRes) {
            this.after.write("return res, err\n");
            return;
        }

        this.after.write(`
            if err != nil || res.StatusCode >= 300 {
                return res, ${resType ? "nil, " : ""}err
            }

            var typ ${resType}
            if err := json.NewDecoder(res.Body).Decode(&typ); err != nil {
                return err
            }

            return res, typ, nil
        `);
    }

    /**
     * Adds a method to query the endpoint on the resource
     * to the associated file.
     */
    method(method: api10.Method) {
        this.file.import("net/http");

        this.func = this.file.func(inferMethodName(this.resource, method));
        this.func.methodOf("c *Client").addArgs(...this.getPathFmtArgs());

        this.options = new WriteCollector();
        this.before = new WriteCollector();
        this.after = new WriteCollector();

        this.generateQueryParams(method);
        this.generateBodyParams(method);
        this.generateFuncReturns(method);

        this.func.write(`
            ${this.before.toString()}
            res, err := c.do(&http.Request{
                Method: "${method.method()}",
                URL: ${this.getPathFmtCall()},
                ${this.options}
            })
            ${this.after.toString()}
        `);
    }
}

export class GoTarget implements Target {

    check(): Promise<void> {
        return Promise.resolve();
    }

    private createEndpoints(api: api10.Api, file: File) {
        const generateMethods = (resource: api10.Resource) => {
            const generator = new Request(file, resource);
            resource.methods().forEach(m => generator.method(m));
            resource.resources().forEach(generateMethods);
        };

        api.resources().forEach(generateMethods);
    }

    private createModels(api: api10.Api, file: File) {
        api.types().forEach(type => {
            if (!("properties" in type)) {
                return;
            }

            generateStruct(file, api, type.name(), <api10.ObjectTypeDeclaration>type);
        });
    }

    generate(api: api10.Api, output: string): Promise<void> {
        const todo = new Todo();
        todo.start("Generating Go code");

        const module = new Module(output, "client");
        module.include(path.join(__dirname, "../../../src/targets/go/bootstrap.go"));
        this.createModels(api, module.file("models.go"));
        this.createEndpoints(api, module.file("endpoints.go"));

        todo.start("Running gofmt");

        return module.save().then(() => todo.finish());
    }
}

export default new GoTarget();