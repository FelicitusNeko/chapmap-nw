import { readFileSync } from 'fs';

interface ReaperNodeInProcessing {
  tag: string;
  params: (string | number)[];
  base64?: string;
  children?: (ReaperNodeInProcessing | string)[];
}

export interface ReaperNode extends ReaperNodeInProcessing {
  children?: ReaperNode[];
}

export class ReaperReader {
  public root: ReaperNode;
  private flatList: ReaperNode[];

  constructor(inFile: string) {
    let rppdata: string = readFileSync(inFile)
      .toString()
      .replace(/^\s+/gm, '')
      .replace(/\r/g, '\n')
      .trim();

    let tags: (string | ReaperNodeInProcessing)[] = [];
    for (let done = false; !done;) {
      let tagsCopy = tags.slice(0);
      done = true;

      rppdata = rppdata.replace(/<[^<]*?>/g, (match: string) => {
        done = false;
        if (!tagsCopy.includes(match)) tagsCopy.push(match);
        return `⭐${tagsCopy.indexOf(match)}`;
      });
      
      tags = tagsCopy;
    }

    this.flatList = [];

    tags = tags.map(i => (i as string).split('\n'))
      .map(i => {
        const splitParams = (data: string) => {
          if (/^⭐\d+$/.test(data)) return data;
          const quoted: string[] = [];

          let splitData = data.replace(/(?<!\\)".*?(?<!\\)"/g, match => {
            if (!quoted.includes(match)) quoted.push(match);
            return `💙${quoted.indexOf(match)}`;
          }).split(' ')

            .map(i => {
              if (i.startsWith('💙')) {
                let iretval = quoted[parseInt(i.replace(/[^\d]+/gu, ''))];
                return iretval.substr(1, iretval.length - 2);
              }
              else return i.replace(/⭐\d+/, match => tags[parseInt(match.replace(/[^\d]+/gu, ''))] as string);
            });

          let retval: ReaperNodeInProcessing = {
            tag: splitData.shift()!,
            params: splitData.map(i => {
              if (typeof i === 'string') {
                if (/^-?\d*\.\d+$/.test(i)) return parseFloat(i);
                else if (/^-?\d+$/.test(i)) return parseInt(i);
              } return i;
            })
          };
          this.flatList.push(retval as ReaperNode);
          return retval;
        }

        if (i.length === 1) return i[0];
        else {
          {
            const checklast = i.pop();
            if (checklast && checklast !== '>') i.push(checklast);
          }

          let retval: ReaperNodeInProcessing = splitParams(i[0].substr(1)) as ReaperNodeInProcessing;

          switch (retval.tag) {
            // These definitely have base64 content
            case 'COMMENT':
            case 'RENDER_CFG':
            case 'VST':
              retval.base64 = i.slice(1).join('');
              break;
            // Everything else
            default:
              retval.children = i.slice(1).map(splitParams) as ReaperNodeInProcessing[];
              break;
          }
          return retval;
        }
      });

    const connectTheDots = (line: string | ReaperNodeInProcessing) => {
      if (typeof line === 'string' && /^⭐\d+$/.test(line)) {
        let retval: ReaperNodeInProcessing = tags[parseInt(line.replace(/[^\d]+/gu, ''))] as ReaperNodeInProcessing;
        if (retval.children) retval.children = retval.children.map(connectTheDots) as ReaperNode[];
        return retval as ReaperNode;
      }
      else return line;
    }
    this.root = connectTheDots(rppdata) as ReaperNode;
  }

  private static internalQuerySelector(nodes: ReaperNode[], ...tagName: string[]) {
    let tagList = nodes;
    let workingTagNames = tagName.slice(0);

    while (workingTagNames.length > 0) {
      const tag = workingTagNames.shift();
      if (tag) tagList = tagList.filter(i => !i.tag.localeCompare(tag, 'en', { sensitivity: 'base' }));

      if (workingTagNames.length > 0) {
        let concatTags: ReaperNode[] = [];
        tagList = tagList.filter(i => i.children);
        while (tagList.length > 0) concatTags = concatTags.concat(tagList.shift()!.children!);
        tagList = concatTags;
      }
    }

    return tagList;
  }

  querySelector(...tagName: string[]) {
    return ReaperReader.internalQuerySelector(this.flatList, ...tagName)
  }

  static querySelectorAgain(rootNode: ReaperNode, ...tagName: string[]) {
    if (!rootNode.children) return [] as ReaperNode[];
    else return this.internalQuerySelector(rootNode.children, ...tagName);
  }

  static nodeContains(nodes: ReaperNode[], subtag: string, value: string | number) {
    return nodes
      .filter(i => i.children)
      .filter(i => {
        let scan = ReaperReader.internalQuerySelector(i.children!, subtag);
        for (const child of scan) if (child.params.includes(value)) return true;
        return false;
      });
  }
}


