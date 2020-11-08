import { ReaperNode, ReaperReader } from './ReaperReader';

export class ItemParser {
  public name: Readonly<string>;
  public start: Readonly<number>;
  public length: Readonly<number>;
  public end: Readonly<number>;
  public source: Readonly<string>;

  constructor(input: ReaperNode) {
    if (input.tag !== 'ITEM') throw new TypeError('Reaper node not an ITEM');
    
    this.name = ReaperReader.querySelectorAgain(input, 'NAME')[0].params[0] as string;
    this.start = ReaperReader.querySelectorAgain(input, 'POSITION')[0].params[0] as number;
    this.length = ReaperReader.querySelectorAgain(input, 'LENGTH')[0].params[0] as number;
    this.end = this.start + this.length;
    this.source = ReaperReader.querySelectorAgain(input, 'SOURCE', 'FILE')[0].params[0] as string;
  }
}