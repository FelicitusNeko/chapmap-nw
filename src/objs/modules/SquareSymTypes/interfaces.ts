import { Duration } from 'luxon';
import { Tags } from 'node-id3';
import { DataType, SegmentType, SOCANType } from './enums';

type ImageData = Tags['image'];

interface ShowChapterData {
  /** The millisecond position when the chapter starts. This may be a number of milliseconds, or a fully-qualified or ISO 8601 duration. */
  start: number | string;

  /**
   * If specified, the millisecond position when the chapter ends. If omitted, this will be either the start of the next chapter, or the end of the episode.
   * This may be a number of milliseconds, or a fully-qualified or ISO 8601 duration.
   */
  end?: number | string;

  /** The chapter type code. */
  type: DataType;

  /** For segments, the title of the segment. For music, the name of the track. */
  title?: string;

  /**
   * The CRTC designation code. Valid codes include, but are not limited to:
   * 
   * 11: News
   * 12: Spoken word (including spoken station IDs) and PSA
   * 21: Pop, Rock, Dance, R&B
   * 36: Experimental
   * 43: Station ID cart
   * 45: Station promotional cart (for another show)
   * 51: Paid advertisement
   */

  crtc?: number;

  /**
   * For the Twitch playlist, how the title of the segment should be displayed.
   * Use '~~' for a line break. Lines are up to 32 characters long, and there may be up to two.
   */
  displayTitle?: string;

  /**
   * For the Twitch playlist, how the track information should be displayed.
   * Use '~~' for a line break. Lines are up to 32 characters long, and there may be up to two.
   */
  displaySong?: string;

  /**
   * The image to be displayed in the chapter data.
   * For the Twitch playlist, this refers to either the segment logo for segments, or the cover art for music.
   */
  image?: string | ImageData;

  /** Any associated URL to be added to the chapter data. */
  url?: string;

  /** If this episode falls within a SOCAN reporting period, the time when the song for this segment plays. Does not apply to carts. Required if SOCAN is true. */
  SOCANTime?: string;
}

interface SegmentChapterData extends ShowChapterData {
  /** In the case of spoken-word segments, the type must be 'seg'. */
  type: DataType.Segment;

  /** The segment type code. */
  segType?: SegmentType;

  /** The title of the track played as background for this segment. */
  songTitle?: string;

  /** The artist who performed the track. */
  artist?: string;

  /** The album from which this track originates. */
  album?: string;

  /** For station tracking purposes, whether this track meets MAPL guidelines for Canadian Content. */
  CanCon?: boolean;

  /** The length of the spoken-word content, in ISO 8601 duration notation. Example: 'PT2M1S' would mean two minutes and one second. */
  contentLength?: string;

  /** The name of the game being covered in this segment, if applicable. */
  game?: string;

  /** For Archives segments, the game ID number on the LowBiasGaming page. */
  gameId?: number;

  /** The name of the guest included in this segment. */
  guest?: string;

  /** For News of the Weird segments, whether the weather was called. Usually only applies to live broadcasts, as they are required by the CRTC for them. */
  weather?: boolean;

  /**
   * For News of the Weird segments, the date from which the news was pulled.
   * If it was pulled from multiple dates, specify the date from which most of the news was pulled.
   */
  newsDate?: string;
}

interface MusicChapterData extends ShowChapterData {
  /** In the case of music, the type must be 'music'. */
  type: DataType.Music;

  /** An MP3 file from which to pull tags to automatically populate track data. If this is specified, other music-specific data in this object is ignored. */
  from?: string;

  /** The artist who performed the track. Ignored if 'from' is specified. */
  artist?: string;

  /** The album from which this track originates. Ignored if 'from' is specified. */
  album?: string;

  /** For station tracking purposes, whether this track meets MAPL guidelines for Canadian Content. Ignored if 'from' is specified. */
  CanCon?: boolean;

  /** For station tracking purposes, whether this song has lyrics. Otherwise, it will be assumed to be instrumental. Ignored if 'from' is specified. */
  hasLyrics?: boolean;

  /** Whether this is a new track as defined by CKDU. Ignored if 'from' is specified. */
  newSong?: boolean;

  /** For chapter and Twitch playlist, this will change the display to indicate this is music related to this episode's From The Archives. */
  archives?: boolean;
}

interface CartChapterData extends ShowChapterData {
  /** In the case of carts, the type must be 'carts'. */
  type: DataType.Carts;

  /** The estimated time when the cart aired. */
  estTime?: string;
}

interface GuestData {
  /** Whether this person was a guest. If not, they will be handled as a mention. */
  _guest?: boolean;

  /**
   * Any links related to the guest or mention.
   * 
   * The following sites are recognised, and full URLs can be generated from user or account name:
   * Bandcamp, SoundCloud, YouTube, Twitter, Twitch, Facebook, Instagram, Linktree
   * 
   * Any other sites must point to a full URL.
   */
  links?: Record<string, string>;
}

interface ShowData {
  /** The title of the episode. */
  title: string;

  /** The season number for the episode. If the episode is a special, 'SP' is permitted. */
  season: number | 'SP';

  /** The episode number for the episode. */
  episode: number;

  /** The year the episode was released. */
  year: number;

  /** The airdate of the episode, in the format 'Month Day(th), Year'. */
  airdate: string;

  /** The short description of the episode. Must not exceed 255 characters. */
  description: string;

  /** Data about guests and mentions on the show. */
  guest?: Record<string, GuestData>;

  /** Whether the episode falls within a SOCAN reporting period. If it does, additional information will be required. */
  SOCAN?: boolean;

  /** Whether the episode is intended to be simulcast live on Twitch. This will add a portion to the long description. */
  twitchSimulcast?: boolean;

  /** Whether this episode is nonstandard. This will remove the 'Electric Leftovers' credit. */
  nonstandardEpisode?: boolean;

  /** Whether the episode features explicit language. Unlikely to happen, but here just in case. */
  explicitLanguage?: boolean;

  /** The data for each chapter of the show. */
  chapters: ShowChapterData[];

  /** For the end credits, the list of shows coming up next that must be called. */
  nextOnCKDU: Record<string, string>;

  /** Any additional keywords (up to 9) to add to the default keywords. */
  keywords?: string[];

  /** Any additional categories (up to 2) to assign to the episode, aside from the seasonal one. */
  categories?: string[];
}

interface AlternateData {
  /** The chapter type code. */
  type: DataType;

  /** The title for this segment. */
  title?: string;

  /** The image to be used for the segment. */
  image?: string | ImageData;

  /** The title of the track. */
  songTitle?: string;

  /** The artist who performed the track. */
  artist?: string;

  /** The album from which this track originates, if any. If not specified, it will be assumed to be a single. */
  album?: string;

  /** For the Twitch playlist, how the title of the segment should be displayed. Use '~~' for a line break. Lines are up to 32 characters long, and there may be up to two. */
  displayTitle?: string;

  /** For the Twitch playlist, how the track information should be displayed. Use '~~' for a line break. Lines are up to 32 characters long, and there may be up to two. */
  displaySong?: string;

  /** Whether the track meets MAPL guidelines for Canadian Content. */
  CanCon?: boolean;

  /** A link to any pertinent information to the segment. */
  url?: string;

  /** A link to the origin of the track. */
  songUrl?: string;

  /** The image to be used for the track. */
  songImage?: string | ImageData;

  /** For chapter and Twitch playlist, this will change the display to indicate this is music related to this episode's From The Archives. */
  archives?: boolean;

  /** The data to be inserted into the CKDU tracker system. */
  tracker?: {
    /**
     * The CRTC designation code. Valid codes include, but are not limited to:
     * 
     * 11: News
     * 12: Spoken word (including spoken station IDs) and PSA
     * 21: Pop, Rock, Dance, R&B
     * 36: Experimental
     * 43: Station ID cart
     * 45: Station promotional cart (for another show)
     * 51: Paid advertisement
     */
    crtc: number;

    /** The time at which the item was played. */
    timePlayed?: string;

    /** The length of the item. */
    length?: Duration;

    /** The language of the song. If not specified, 'English' will be assumed. */
    language?: string;

    /** For music, whether the song had lyrics. If not, it will be treated as instrumental. */
    hasLyrics?: boolean;

    /** For music, whether the song is a new release. */
    newSong?: boolean;

    /** Contains SOCAN song tracking data, if any. */
    SOCAN?: {
      /** Whether this song is a theme song, background music, or neither. If both, theme song prevails. */
      type: SOCANType;

      /** The exact time to the minute when the song played. */
      time: string;
    };
  }
}

export type { ShowData, ShowChapterData, SegmentChapterData, MusicChapterData, CartChapterData, AlternateData };
//export { ShowChapterData };